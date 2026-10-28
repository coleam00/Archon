import { finishNodeExecution } from '../../../node-execution';
import { type NodeExecutionResult } from '../../../node-record-serialization';
import { type NodeFailureKind } from '../../../schemas/node-execution';
import { recordNodeState } from '../../../node-event-write';
import type { SendQueryOptions, ProviderFailure } from '@archon/provider-contract';
import type { AgentNode, EffortLevel } from '../../../schemas';
import { isNodeContextResume } from '../../../schemas';
import { createAttemptEventSequence } from '../../../provider-events';
import { declaredOutputPathsFromSchema } from '../../../output-ref';
import { STEP_IDLE_TIMEOUT_MS } from '../../../utils/idle-timeout';
import { safeSendMessage, type SendMessageContext } from '../../../platform-messages';
import { type TierName } from '../../../model-validation';
import { getLog } from '../../log';
import { loadNodeCommandPrompt } from '../../node-source';
import {
  aiNodeEnvironment,
  type RunLayersContext,
  type SessionCheckpoint,
  type SessionResumeIntent,
} from '../../run-context';
import { substituteLoopBodyText } from '../../loop-scope';
import { rejectedArtifactPointer } from '../../node-output';
import { lastNodeCancelCheck, lastNodeActivityUpdate } from '../../run-control';
import {
  formatWatchdogResetDiagnostic,
  cutOffClause,
  unsettledTurnError,
  NodeFailure,
} from '../../ai-turn';
import { bindAgentNode, type AgentBinding } from './agent-binding';
import { loadAgentPrompt } from './agent-prompt';
import { createAttemptState, type AgentAttemptState, type AgentPassContext } from './agent-stream';
import { runUntilStructuredOutputValid } from './agent-reask';

export async function executeAgentNode(
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
  const { deps, platform, conversationId, workflowRun, logDir } = ctx;
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Persisted step_name is namespaced ('<groupId>.' prefix) for loop_group bodies;
  // '' for the top-level DAG → identical to node.id. The in-process emitter payloads
  // below stay raw (node.id) — live SSE/CLI consumers key off those. See #2090.
  const stepName = stepNamePrefix + node.id;
  const session: AttemptSession = {
    resumeSessionId,
    resumeIntent,
    namedResumeSourceNodeId: isNodeContextResume(node.context) ? node.context.resume : undefined,
    checkpointSession,
  };
  const commandPrompt =
    node.source.kind === 'command'
      ? await loadNodeCommandPrompt(
          ctx,
          substituteLoopBodyText(node.source.name, ctx.loopBodyScopes),
          stepName
        )
      : undefined;
  const binding = await bindAgentNode(ctx, node, {
    stepName,
    provider,
    reserveBudget,
    resolvedModel,
    resolvedTier,
    resolvedEffort,
    resumeSessionId,
    resumeIntent,
    namedResumeSourceNodeId: session.namedResumeSourceNodeId,
    iteration,
    nodeContext,
  });
  const { execution, nodeMcp } = binding;
  const state = createAttemptState(ctx, node.id);
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
          tokens: state.tokens,
          tokensUnknown: state.tokensUnknown,
          costUsd: state.costUsd,
          costPartial: state.costReportMissing,
          stopReason: state.stopReason,
          numTurns: state.numTurns,
          resolvedModel: state.resolvedModel?.id,
          sessionId: state.sessionId,
          providerNotCalled: extras.providerNotCalled,
        }
      )
    );
    lastNodeCancelCheck.delete(nodeKey);
    lastNodeActivityUpdate.delete(nodeKey);
    return result;
  };

  const prompt = loadAgentPrompt(ctx, node, stepName, commandPrompt, {
    typedArtifactsFile,
    rejectionReason,
  });
  if (!prompt.ok) {
    // The provider is bound but was never called, so the attempt records no spend rather
    // than unreported spend that would refuse a spend-limited run.
    const result = await failAgentNode(prompt.error, 'config', { providerNotCalled: true });
    if (prompt.notify) {
      await safeSendMessage(
        platform,
        conversationId,
        `Node '${node.id}' failed: ${prompt.error}`,
        nodeContext
      );
    }
    return result;
  }

  // Per-node abort controller, for idle timeout, operator cutoff and cancellation.
  const abortController = new AbortController();
  const pc: AgentPassContext = {
    ctx,
    node,
    stepName,
    provider,
    capabilities: binding.capabilities,
    nodeMcp,
    aiClient: binding.aiClient,
    nodeOptions,
    queryOptions: attemptQueryOptions(ctx, binding, nodeOptions, session, abortController),
    attemptEvents: createAttemptEventSequence(execution.attempt.id),
    nodeContext,
    streamingMode: platform.getStreamingMode(),
    abortController,
    idleTimeoutMs: node.idle_timeout ?? STEP_IDLE_TIMEOUT_MS,
    nodeKey,
    nodeStartTime,
    staleResumeRetry: session.namedResumeSourceNodeId === undefined,
  };

  let result: WorkloadResult;
  try {
    result = await runWorkload(pc, state, prompt.prompt, session);
  } catch (error) {
    const cancelled = abortController.signal.aborted && !state.cutOff;
    const failure = attemptFailure(error as Error, cancelled, nodeMcp, node.id);
    return failAgentNode(failure.message, failure.kind, {
      providerFailure: failure.providerFailure,
    });
  }
  if (result.state === 'failed') {
    return failAgentNode(result.error, result.failureKind, { output: result.output });
  }
  const duration = Date.now() - nodeStartTime;
  getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');

  const { namedResumeSourceNodeId } = session;
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
        tokens: state.tokens,
        tokensUnknown: state.tokensUnknown,
        costUsd: state.costUsd,
        costPartial: state.costReportMissing,
        stopReason: state.stopReason,
        numTurns: state.numTurns,
        resolvedModel: state.resolvedModel?.id,
        sessionId: result.sessionId,
        resumed: result.resumed,
        durationMs: duration,
        diagnostics: {
          ...execution.diagnostics,
          ...(node.output_type !== undefined ? { outputType: node.output_type } : {}),
          ...(namedResumeSourceNodeId !== undefined
            ? { sessionForked: resumeIntent !== 'owner-continuation' }
            : {}),
          ...(state.backgroundTasksIncomplete.length > 0
            ? { backgroundTasksIncomplete: state.backgroundTasksIncomplete }
            : {}),
        },
      }
    ),
    { resumed: result.resumed }
  );

  // Clean up throttle entries on completion
  lastNodeCancelCheck.delete(nodeKey);
  lastNodeActivityUpdate.delete(nodeKey);

  return completed;
}

/** The session the attempt resumes, and what it must prove about the session it ends on. */
interface AttemptSession {
  resumeSessionId: string | undefined;
  resumeIntent: SessionResumeIntent;
  /** The node named by `context: { resume }`, when this node resumes one. */
  namedResumeSourceNodeId: string | undefined;
  checkpointSession: SessionCheckpoint | undefined;
}

type WorkloadResult =
  | (NodeExecutionResult & { state: 'completed' })
  | { state: 'failed'; output: string; error: string; failureKind: NodeFailureKind };

/** How a thrown attempt is recorded: a cancellation wins over whatever error the abort caused. */
function attemptFailure(
  err: Error,
  cancelled: boolean,
  nodeMcp: AgentBinding['nodeMcp'],
  nodeId: string
): { message: string; kind: NodeFailureKind; providerFailure?: ProviderFailure } {
  if (cancelled) {
    getLog().info({ nodeId }, 'dag_node_cancelled_via_abort');
    return { message: 'Cancelled by user', kind: 'cancelled' };
  }
  getLog().error({ err, nodeId }, 'dag_node_failed');
  return {
    message: nodeMcp.kind === 'missing' ? `${err.message}\n${nodeMcp.diagnostic}` : err.message,
    kind: err instanceof NodeFailure ? err.kind : 'unknown',
    providerFailure: err instanceof NodeFailure ? err.providerFailure : undefined,
  };
}

function attemptQueryOptions(
  ctx: RunLayersContext,
  { nodeMcp, execution }: AgentBinding,
  nodeOptions: SendQueryOptions | undefined,
  { resumeSessionId, resumeIntent }: AttemptSession,
  abortController: AbortController
): SendQueryOptions {
  const shouldForkSession = resumeSessionId !== undefined && resumeIntent !== 'owner-continuation';
  return {
    ...nodeOptions,
    env: { ...nodeOptions?.env, ...aiNodeEnvironment(ctx, execution) },
    ...(nodeMcp.kind === 'load' || nodeMcp.kind === 'missing'
      ? { nodeConfig: { ...nodeOptions?.nodeConfig, mcp: nodeMcp.path } }
      : {}),
    abortSignal: abortController.signal,
    ...(resumeIntent === 'owner-continuation'
      ? { forkSession: false }
      : shouldForkSession
        ? { forkSession: true }
        : {}),
  };
}

async function runWorkload(
  pc: AgentPassContext,
  state: AgentAttemptState,
  finalPrompt: string,
  session: AttemptSession
): Promise<WorkloadResult> {
  const { node, ctx } = pc;
  await runUntilStructuredOutputValid(
    pc,
    state,
    finalPrompt,
    session.resumeSessionId,
    session.resumeIntent === 'source-fork'
  );

  const failed = await finishTurnOutput(pc, state);
  if (failed !== undefined) return failed;

  if (session.namedResumeSourceNodeId !== undefined) {
    assertNamedSessionResumed(node.id, state, session, session.namedResumeSourceNodeId);
  }

  if (state.sessionId !== undefined) {
    await session.checkpointSession?.(state.sessionId);
  }

  // Artifact pointers are validated here, before any node_completed row exists, so a
  // result naming a file it may not address fails this node instead of handing a
  // downstream consumer a location the engine never checked (#2453).
  if (state.structuredOutput !== undefined) {
    const badPointer = await rejectedArtifactPointer(ctx.workflowRun, state.structuredOutput);
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
    output: state.outputText,
    sessionId: state.sessionId,
    costUsd: state.costUsd,
    ...(state.tokens !== undefined ? { tokens: state.tokens } : {}),
    ...(state.structuredOutput !== undefined ? { structuredOutput: state.structuredOutput } : {}),
    ...(declaredOutputPaths !== undefined ? { declaredOutputPaths } : {}),
    ...(state.resumed !== undefined ? { resumed: state.resumed } : {}),
  };
}

/**
 * Fails a turn that was cut off, cancelled or empty, and flushes a batched reply otherwise.
 * Returns undefined when the turn produced output and finished.
 */
async function finishTurnOutput(
  pc: AgentPassContext,
  state: AgentAttemptState
): Promise<WorkloadResult | undefined> {
  // If cancelled during streaming (not idle timeout or an end-turn request), return as failed with cancel reason
  if (pc.abortController.signal.aborted && !state.cutOff) {
    const duration = Date.now() - pc.nodeStartTime;
    getLog().info(
      { nodeId: pc.node.id, durationMs: duration },
      'dag_node_cancelled_during_streaming'
    );
    return {
      state: 'failed',
      output: state.outputText,
      error: 'Cancelled by user',
      failureKind: 'cancelled',
    };
  }
  assertTurnSettled(pc, state);

  if (pc.streamingMode === 'batch' && state.batchMessages.length > 0) {
    const batchContent =
      state.structuredOutput !== undefined && pc.nodeOptions?.outputFormat
        ? state.outputText
        : state.batchMessages.join('\n\n');
    await safeSendMessage(pc.ctx.platform, pc.ctx.conversationId, batchContent, pc.nodeContext);
  }

  // Fail for zero output: covers both silent non-timeout exits AND idle-timeout before first token (time-to-first-token exceeded the window).
  if (state.outputText.trim() === '' && state.structuredOutput === undefined) {
    return emptyOutputFailure(pc, state);
  }
  return undefined;
}

// Every provider ends a turn with `settled`. Output without it means the stream was
// cut off (idle timeout, operator request, a provider that died or broke the contract), so the node
// fails rather than completing on a turn that may not be done. Zero output falls
// through to the empty-output guard; cancellation is handled by the caller.
function assertTurnSettled(pc: AgentPassContext, state: AgentAttemptState): void {
  const { cutOff } = state;
  if (state.settled) return;
  if (state.outputText.trim() === '' && state.structuredOutput === undefined) return;
  throw new NodeFailure(
    cutOff ? 'timeout' : 'unknown',
    `Node '${pc.node.id}' failed: ${unsettledTurnError(cutOff, state.backgroundTasksIncomplete)}`
  );
}

function emptyOutputFailure(pc: AgentPassContext, state: AgentAttemptState): WorkloadResult {
  const nodeId = pc.node.id;
  const duration = Date.now() - pc.nodeStartTime;
  const emptyError =
    state.cutOff?.kind === 'operator'
      ? `Node '${nodeId}' ${cutOffClause()}, before producing output.`
      : state.cutOff?.kind === 'idle_timeout'
        ? `Node '${nodeId}' timed out with no output (idle for ${String(pc.idleTimeoutMs / 60000)} min).${formatWatchdogResetDiagnostic(state.cutOff.lastReset)} Consider increasing idle_timeout or reducing prompt size.`
        : `Node '${nodeId}' produced no assistant output. The provider stream closed without yielding content — likely a silent provider rejection or stream interruption.`;
  getLog().error({ nodeId, durationMs: duration }, 'dag.node_empty_output');
  return {
    state: 'failed',
    output: '',
    error: emptyError,
    failureKind: state.cutOff ? 'timeout' : 'transient',
  };
}

function assertNamedSessionResumed(
  nodeId: string,
  state: AgentAttemptState,
  { resumeIntent, resumeSessionId }: AttemptSession,
  sourceNodeId: string
): void {
  const newSessionId = state.sessionId;
  if (state.resumed !== true) {
    throw new Error(
      `Node '${nodeId}' could not resume the exact session from '${sourceNodeId}'. The provider reported that prior context was not restored.`
    );
  }
  if (newSessionId === undefined || newSessionId.trim() === '') {
    throw new Error(
      `Node '${nodeId}' resumed '${sourceNodeId}' but the provider returned no branch session ID.`
    );
  }
  if (resumeIntent === 'owner-continuation' && newSessionId !== resumeSessionId) {
    throw new Error(
      `Node '${nodeId}' did not continue its private owner session: the provider replaced the session ID.`
    );
  }
  if (resumeIntent !== 'owner-continuation' && newSessionId === resumeSessionId) {
    throw new Error(
      `Node '${nodeId}' did not create an immutable fork of '${sourceNodeId}': the provider reused the source session ID.`
    );
  }
}
