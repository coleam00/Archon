import { DEFAULT_TOOL_CALL_ATTENTION_MS } from '../../../schemas/run-config';
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  ResolvedModel,
  ResultChunk,
  SendQueryOptions,
  TokenUsage,
} from '@archon/provider-contract';
import { sessionPreview } from '@archon/provider-contract';
import type { AgentNode } from '../../../schemas';
import {
  createProviderEventHandler,
  type AttemptEventSequence,
  type ProviderEventHandler,
} from '../../../provider-events';
import { createWatchdogResetRecorder, type WatchdogResetRecorder } from '../../../logger';
import { withIdleTimeout } from '../../../utils/idle-timeout';
import { withStaleResumeRetry } from '../../../stale-resume';
import { isEndTurnRequested } from '../../../end-turn-request';
import { safeSendMessage, type SendMessageContext } from '../../../platform-messages';
import { getLog } from '../../log';
import { sumTokenUsage } from '../../usage';
import type { RunLayersContext } from '../../run-context';
import {
  shouldContinueStreamingForStatus,
  lastNodeCancelCheck,
  lastNodeActivityUpdate,
  CANCEL_CHECK_INTERVAL_MS,
  ACTIVITY_HEARTBEAT_INTERVAL_MS,
} from '../../run-control';
import type { NodeMcpResolution } from '../../provider-resolution';
import {
  type TurnCutOff,
  type WatchdogReset,
  type structuredOutputPass,
  providerReportedFailure,
} from '../../ai-turn';

/** What every stream pass of one agent attempt reads and never changes. */
export interface AgentPassContext {
  ctx: RunLayersContext;
  node: AgentNode;
  stepName: string;
  provider: string;
  capabilities: ProviderCapabilities;
  nodeMcp: NodeMcpResolution;
  aiClient: IAgentProvider;
  /** The dispatcher's options: output_format and the budget cap are read from here. */
  nodeOptions: SendQueryOptions | undefined;
  /** What `sendQuery` receives: the node options plus the attempt's env, MCP file, abort signal and fork mode. */
  queryOptions: SendQueryOptions;
  /** Every pass of the attempt (a structured-output reask is a second pass) numbers its provider events from one sequence. */
  attemptEvents: AttemptEventSequence;
  nodeContext: SendMessageContext;
  streamingMode: 'stream' | 'batch';
  abortController: AbortController;
  idleTimeoutMs: number;
  /** The throttle key of `lastNodeCancelCheck` and `lastNodeActivityUpdate`. */
  nodeKey: string;
  nodeStartTime: number;
  /** False for a named resume, which never falls back to a fresh session. */
  staleResumeRetry: boolean;
}

/**
 * One attempt's mutable state. Stream passes write it, and the node record reads it on every
 * exit, including a pass that throws, so usage spent before a failure still lands.
 */
export interface AgentAttemptState {
  tokens: TokenUsage | undefined;
  tokensUnknown: boolean;
  costUsd: number | undefined;
  /** Attempt-wide: some pass ended without a result, or a result without a finite cost, so `costUsd` is at most a floor. */
  costReportMissing: boolean;
  passSawResult: boolean;
  stopReason: string | undefined;
  numTurns: number | undefined;
  resolvedModel: ResolvedModel | undefined;
  sessionId: string | undefined;
  resumed: boolean | undefined;
  /** Always accumulated, whatever the streaming mode. */
  outputText: string;
  structuredOutput: unknown;
  batchMessages: string[];
  /** What cut the last pass off before it settled, if anything did. */
  cutOff: TurnCutOff | undefined;
  lastWatchdogReset: WatchdogReset | undefined;
  watchdogResets: WatchdogResetRecorder;
  /**
   * Task ids still live when the stream ended abnormally (idle timeout / operator cutoff / subprocess death),
   * recorded on the node_completed event so an incomplete node never masquerades as a clean
   * success (#2083).
   */
  backgroundTasksIncomplete: string[];
  /** Whether the last pass ended on the provider's `settled`. Output without it means the turn was cut off, not finished. */
  settled: boolean;
}

export function createAttemptState(ctx: RunLayersContext, nodeId: string): AgentAttemptState {
  return {
    tokens: undefined,
    tokensUnknown: false,
    costUsd: undefined,
    costReportMissing: false,
    passSawResult: false,
    stopReason: undefined,
    numTurns: undefined,
    resolvedModel: undefined,
    sessionId: undefined,
    resumed: undefined,
    outputText: '',
    structuredOutput: undefined,
    batchMessages: [],
    cutOff: undefined,
    lastWatchdogReset: undefined,
    watchdogResets: createWatchdogResetRecorder(ctx.logDir, ctx.workflowRun.id, nodeId),
    backgroundTasksIncomplete: [],
    settled: false,
  };
}

function passChunks(
  pc: AgentPassContext,
  prompt: string,
  resumeSessionId: string | undefined
): AsyncGenerator<MessageChunk> {
  const send = (id: string | undefined): AsyncGenerator<MessageChunk> =>
    pc.aiClient.sendQuery(prompt, pc.ctx.cwd, id, pc.queryOptions);
  if (!pc.staleResumeRetry) return send(resumeSessionId);
  return withStaleResumeRetry(send, resumeSessionId, {
    logContext: { workflowRunId: pc.ctx.workflowRun.id, nodeId: pc.node.id },
  });
}

/**
 * One sendQuery stream pass. Resets the per-pass state first, so a prior reask pass's output,
 * batch buffer, cost and cutoff cause never leak into this one, then streams. Throws on an
 * SDK error or the budget cap; those failures are never reasked.
 */
export async function runStreamPass(
  pc: AgentPassContext,
  state: AgentAttemptState,
  prompt: string,
  pass: ReturnType<typeof structuredOutputPass>
): Promise<void> {
  resetPass(pc, state, pass);
  const providerEvents = createPassEventHandler(pc, state);
  const shouldStopStream = stopCheck(pc, state, providerEvents);
  try {
    for await (const msg of withIdleTimeout(
      passChunks(pc, prompt, pass.resumeSessionId),
      pc.idleTimeoutMs,
      () => onIdleTimeout(pc, state),
      (msg, resetAt) => {
        const type = msg.type;
        state.lastWatchdogReset = { type, at: resetAt };
        state.watchdogResets.observe(type, resetAt);
      },
      () =>
        providerEvents.hasOpenTools() ||
        (pc.capabilities.backgroundWork === 'reported' &&
          providerEvents.liveSubtaskIds().length > 0),
      shouldStopStream
    )) {
      const tickNow = Date.now();

      if (msg.type === 'result') recordResult(pc, state, pass, msg);
      else if (msg.type !== 'settled') await providerEvents.handle(msg);
      const stopped = await shouldStopStream();
      if (msg.type === 'result' && (!stopped || state.cutOff)) throwOnResultError(pc, msg);
      if (stopped) break;

      await heartbeat(pc, tickNow);

      if (msg.type === 'settled') {
        state.settled =
          pc.capabilities.backgroundWork !== 'reported' ||
          providerEvents.liveSubtaskIds().length === 0;
        break;
      }
    }
  } finally {
    await providerEvents.clearAttention();
  }

  // Stream ended with subtasks still live: the SDK subprocess died, the idle
  // timeout fired mid-wait, or the operator ended the turn, so the tasks' artifacts may be missing (#2083).
  // Record them for the audit trail. The operator hears about it once, from the
  // node's failure: a stream that produced output and never settled fails the node
  // and names these tasks (see unsettledTurnError).
  if (providerEvents.liveSubtaskIds().length > 0) {
    state.backgroundTasksIncomplete = providerEvents.liveSubtaskIds();
    getLog().warn(
      {
        nodeId: pc.node.id,
        taskIds: state.backgroundTasksIncomplete,
        cutOff: state.cutOff,
        cancelled: pc.abortController.signal.aborted && !state.cutOff,
      },
      'dag.node_stream_ended_with_live_background_tasks'
    );
  }
}

function resetPass(
  pc: AgentPassContext,
  state: AgentAttemptState,
  pass: ReturnType<typeof structuredOutputPass>
): void {
  state.outputText = '';
  state.structuredOutput = undefined;
  if (pass.threadsSession) {
    state.sessionId = undefined;
    state.resumed = undefined;
  }
  state.batchMessages.length = 0; // else a failed attempt's prose flushes during reask
  state.costUsd = undefined;
  state.passSawResult = false;
  state.tokens = undefined;
  state.cutOff = undefined;
  state.lastWatchdogReset = undefined;
  state.settled = false;
  state.watchdogResets = createWatchdogResetRecorder(
    pc.ctx.logDir,
    pc.ctx.workflowRun.id,
    pc.node.id
  );
  state.backgroundTasksIncomplete = [];
}

function createPassEventHandler(
  pc: AgentPassContext,
  state: AgentAttemptState
): ProviderEventHandler {
  const { ctx, nodeContext } = pc;
  const { platform, conversationId } = ctx;
  return createProviderEventHandler({
    toolAttention: ctx.toolAttention.createStream({
      nodeId: pc.stepName,
      reportedBackgroundWork: pc.capabilities.backgroundWork === 'reported',
      provider: pc.provider,
      thresholdMs: ctx.config.workflows?.toolCallAttentionMs ?? DEFAULT_TOOL_CALL_ATTENTION_MS,
      env: {
        ...(ctx.execContext.kind === 'host' ? process.env : {}),
        ...pc.queryOptions.env,
      },
      protectedEnvKeys: ctx.config.protectedEnvKeys,
      protectedCredentialValues: ctx.config.protectedCredentialValues,
    }),
    store: ctx.deps.store,
    platform,
    conversationId,
    messageContext: nodeContext,
    logDir: ctx.logDir,
    runId: ctx.workflowRun.id,
    nodeId: pc.node.id,
    stepName: pc.stepName,
    attempt: pc.attemptEvents,
    configuredMcpServers: pc.nodeMcp.kind === 'load' ? pc.nodeMcp.servers : new Set(),
    onMessageText: async text => {
      state.outputText += text; // ALWAYS capture for $node_id.output
      if (pc.streamingMode === 'stream') {
        await safeSendMessage(platform, conversationId, text, nodeContext);
      } else {
        state.batchMessages.push(text);
      }
    },
    // A warning goes out at once (a Pi extension's review URL must reach the user
    // before the node blocks), so the batched reply before it goes out first. A
    // structured-output node is left alone: its batch is replaced by the parsed output.
    beforeWarning: async () => {
      if (state.batchMessages.length === 0 || pc.nodeOptions?.outputFormat) return;
      await safeSendMessage(
        platform,
        conversationId,
        state.batchMessages.join('\n\n'),
        nodeContext
      );
      state.batchMessages.length = 0;
    },
  });
}

/**
 * Refreshes tool attention and, throttled, aborts the stream once the run is no longer
 * streaming or the operator ended this stream's stalled turn.
 */
function stopCheck(
  pc: AgentPassContext,
  state: AgentAttemptState,
  providerEvents: ProviderEventHandler
): () => Promise<boolean> {
  const { ctx, node, nodeKey } = pc;
  return async () => {
    await ctx.toolAttention.refresh();
    await providerEvents.refreshAttention();
    const tickNow = Date.now();
    if (tickNow - (lastNodeCancelCheck.get(nodeKey) ?? 0) > CANCEL_CHECK_INTERVAL_MS) {
      lastNodeCancelCheck.set(nodeKey, tickNow);
      try {
        const streamStatus = await ctx.deps.store.getWorkflowRunStatus(ctx.workflowRun.id);
        if (!shouldContinueStreamingForStatus(streamStatus)) {
          getLog().info(
            {
              workflowRunId: ctx.workflowRun.id,
              nodeId: node.id,
              status: streamStatus ?? 'deleted',
            },
            'dag.stop_detected_during_streaming'
          );
          pc.abortController.abort();
          return true;
        }
        if (await operatorEndedTurn(pc, providerEvents)) {
          state.cutOff = { kind: 'operator' };
          pc.abortController.abort();
          return true;
        }
      } catch (cancelCheckErr) {
        getLog().warn(
          { err: cancelCheckErr as Error, workflowRunId: ctx.workflowRun.id, nodeId: node.id },
          'dag.status_check_failed'
        );
      }
    }

    return false;
  };
}

function onIdleTimeout(pc: AgentPassContext, state: AgentAttemptState): void {
  state.cutOff = {
    kind: 'idle_timeout',
    timeoutMs: pc.idleTimeoutMs,
    lastReset: state.lastWatchdogReset,
  };
  const lastReset = state.lastWatchdogReset;
  getLog().warn(
    {
      nodeId: pc.node.id,
      timeoutMs: pc.idleTimeoutMs,
      ...(lastReset
        ? { lastResetType: lastReset.type, lastResetAt: new Date(lastReset.at).toISOString() }
        : {}),
    },
    'dag_node_idle_timeout_reached'
  );
  pc.abortController.abort();
}

/** Whether the operator ended this pass's turn while it had stalled calls raised. */
async function operatorEndedTurn(
  pc: AgentPassContext,
  providerEvents: ProviderEventHandler
): Promise<boolean> {
  const stall = providerEvents.stall();
  if (stall === undefined) return false;
  const runId = pc.ctx.workflowRun.id;
  if (!(await isEndTurnRequested(pc.ctx.deps.store, runId, stall))) return false;
  getLog().warn({ workflowRunId: runId, nodeId: pc.node.id }, 'dag.turn_ended_by_operator');
  return true;
}

/** Activity heartbeat, throttled to every 60s; only stale/zombie detection reads it. */
async function heartbeat(pc: AgentPassContext, tickNow: number): Promise<void> {
  if (tickNow - (lastNodeActivityUpdate.get(pc.nodeKey) ?? 0) <= ACTIVITY_HEARTBEAT_INTERVAL_MS) {
    return;
  }
  lastNodeActivityUpdate.set(pc.nodeKey, tickNow);
  const workflowRunId = pc.ctx.workflowRun.id;
  try {
    await pc.ctx.deps.store.updateWorkflowActivity(workflowRunId);
  } catch (e) {
    getLog().warn({ err: e as Error, workflowRunId }, 'dag.activity_update_failed');
  }
}

function recordResult(
  pc: AgentPassContext,
  state: AgentAttemptState,
  pass: ReturnType<typeof structuredOutputPass>,
  msg: ResultChunk
): void {
  if (pass.threadsSession) {
    state.sessionId = msg.sessionId;
    if (msg.resumed !== undefined) state.resumed = msg.resumed;
  }
  recordResultUsage(pc.node.id, state, msg);
  if (msg.stopReason !== undefined) state.stopReason = msg.stopReason;
  if (msg.numTurns !== undefined) state.numTurns = msg.numTurns;
  // Assigned UNCONDITIONALLY. A guarded assignment cannot CLEAR a stale value:
  // Pi/Copilot reask loops yield several result chunks, and Pi omits resolvedModel
  // when its later assistant message has no responseModel — so an earlier attempt's
  // model would be persisted as the final attempt's answer. Fabricated attribution
  // is the exact defect #2314 exists to prevent; absence must stay absence.
  state.resolvedModel = msg.resolvedModel;
  if (msg.text !== undefined) {
    state.outputText = msg.text;
    state.batchMessages.splice(0, state.batchMessages.length, msg.text);
  }
  state.structuredOutput = msg.structuredOutput;
}

function recordResultUsage(nodeId: string, state: AgentAttemptState, msg: ResultChunk): void {
  state.tokensUnknown ||= msg.tokensUnknown === true;
  if (state.tokensUnknown) {
    state.tokens = undefined;
  } else if (msg.tokens !== undefined) {
    state.tokens = sumTokenUsage([...(state.tokens ? [state.tokens] : []), msg.tokens], {
      nodeId,
    });
  }
  state.passSawResult = true;
  if (msg.cost === undefined || !Number.isFinite(msg.cost)) state.costReportMissing = true;
  if (msg.cost === undefined) return;
  if (Number.isFinite(msg.cost)) {
    state.costUsd = (state.costUsd ?? 0) + msg.cost;
  } else {
    getLog().warn({ nodeId, costUsd: msg.cost }, 'dag_node.usage_cost_non_finite_ignored');
  }
}

function throwOnResultError(pc: AgentPassContext, msg: ResultChunk): void {
  const nodeId = pc.node.id;
  if (msg.failure !== undefined) {
    throw providerReportedFailure(`Node '${nodeId}'`, msg.failure, pc.nodeOptions?.maxBudgetUsd, {
      nodeId,
      durationMs: Date.now() - pc.nodeStartTime,
    });
  }
  // Fail loudly on any other SDK error result. Previously we broke out of
  // the stream silently, producing empty/partial output without signaling
  // failure — which let failed iterations masquerade as successes.
  // Exception: errorSubtype === 'success' is the Claude SDK's marker for a
  // clean stop_sequence termination. The Claude provider already filters
  // this out, but the guard here keeps a third-party IAgentProvider that
  // forwards the SDK pair raw from producing a "SDK returned success"
  // false failure.
  if (!msg.isError || msg.errorSubtype === 'success') return;
  const subtype = msg.errorSubtype ?? 'unknown';
  const errorsDetail = msg.errors?.length ? ` — ${msg.errors.join('; ')}` : '';
  getLog().error(
    {
      nodeId,
      errorSubtype: subtype,
      errors: msg.errors,
      ...(msg.sessionId ? { sessionIdPreview: sessionPreview(msg.sessionId) } : {}),
      stopReason: msg.stopReason,
      durationMs: Date.now() - pc.nodeStartTime,
    },
    'dag.node_sdk_error_result'
  );
  throw new Error(`Node '${nodeId}' failed: SDK returned ${subtype}${errorsDetail}`);
}
