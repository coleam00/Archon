import { finalizeLoopFromSignal } from '../../loop-completion';
import { requireProvider } from '@archon/provider-contract';
import type { NodeExecutionResult } from '../../../node-record-serialization';
import {
  nodeExecutionMetadataSchema,
  type NodeExecutionRecord,
} from '../../../schemas/node-execution';
import { NodeEventWriteError, recordNodeState } from '../../../node-event-write';
import type { SendQueryOptions, ProviderCapabilities, TokenUsage } from '@archon/provider-contract';
import type {
  ApprovalContext,
  LoopNode,
  EffortLevel,
  LoopGateRunMetadata,
  WorkflowRun,
} from '../../../schemas';
import { nodeInvocationKey } from '../../../node-record-reader';
import { isApprovalContext } from '../../../schemas';
import { createAttemptEventSequence } from '../../../provider-events';
import {
  COMPILED_LOOP_COMMAND,
  resolveIncludeOutputAliases,
  type LoopWithCompiledCommand,
} from '../../../compiled-command';
import { describeUnmetCompletion } from '../../../executor-shared';
import { safeSendMessage } from '../../../platform-messages';
import { type TierName } from '../../../model-validation';
import { getLog } from '../../log';
import { sumTokenUsage } from '../../usage';
import { loadNodeCommandPrompt } from '../../node-source';
import {
  aiNodeEnvironment,
  beginExecution,
  observeNodeCheckout,
  type RunLayersContext,
  type SessionCheckpoint,
} from '../../run-context';
import { getEffectiveNodeRetryConfig } from '../../retry';
import {
  failLoopNode,
  loopSpend,
  type LoopResume,
  type LoopRun,
  type LoopState,
} from './loop-state';
import { runLoopIteration } from './iteration';

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
 * Execute a loop node — runs the prompt until a declared completion channel fires or the
 * maximum iteration count is reached.
 *
 * Key behaviors:
 * - Returns NodeExecutionResult (not void) — DAG executor owns workflow lifecycle
 * - Receives upstream node outputs for $nodeId.output substitution
 * - Does not write current_step_index (DAG tracks per-node completion)
 */
export async function executeLoopNode(
  ctx: RunLayersContext,
  node: LoopNode,
  workflowProvider: string,
  resolvedOptions: SendQueryOptions | undefined,
  resolvedModel?: string,
  resolvedTier?: TierName,
  resolvedEffort?: EffortLevel,
  checkpointSession?: SessionCheckpoint
): Promise<NodeExecutionResult> {
  const { deps, platform, conversationId, workflowRun, logDir } = ctx;
  const loop = node.loop;
  const msgContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Namespaced persisted step_name when this loop node runs inside a loop_group body
  // ('' → node.id at top level, #2090). The loop's own per-iteration number lives in
  // each event's data (`iteration`), so no separate iteration param is threaded here.
  const stepName = ctx.stepNamePrefix + node.id;

  // A bare approval completes the captured execution without starting another attempt.
  // Feedback continues the invocation with a new attempt and the currently resolved binding.
  getLog().info({ nodeId: node.id, type: 'loop' }, 'loop_node.started');

  const newExecution = beginExecution(ctx, node, {
    provider: workflowProvider,
    model: resolvedModel,
    tier: resolvedTier,
    effort: resolvedEffort,
  });
  const resume = readLoopResume(workflowRun, node, newExecution);
  const { savedExecution } = resume;
  const resumedExecution = savedExecution ?? newExecution;
  const state: LoopState = {
    execution: resumedExecution,
    lastStartedIteration: resume.startIteration - 1,
    sessionId: resume.gate?.sessionId ?? undefined,
    stopReason:
      resumedExecution.spend.stopReason.source === 'provider'
        ? resumedExecution.spend.stopReason.value
        : undefined,
    numTurns:
      resumedExecution.spend.numTurns.source === 'provider'
        ? resumedExecution.spend.numTurns.value
        : undefined,
    resolvedModel: undefined,
    costUsd: resume.costUsd,
    tokens: resume.tokens,
    tokensUnknown:
      savedExecution?.spend.tokens.source === 'unavailable' &&
      savedExecution.spend.tokens.reason === 'incomplete',
    // A resumed loop continues from the paused iteration, so its output stays the
    // previous output for $LOOP_PREV_OUTPUT and until_bash.
    lastOutput: resume.gate?.iterationOutput ?? '',
    lastStructuredOutput: undefined,
    backgroundTasksIncomplete: new Set<string>(),
  };
  const finalized = await finalizeOnBareApprove(ctx, node, {
    stepName,
    resume,
    savedExecution,
    sessionId: state.sessionId,
    checkpointSession,
  });
  if (finalized !== undefined) return finalized;

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
    return failLoopNode(ctx, node.id, state, errorMsg, { failureKind: 'config' });
  }

  // A continuation after an interactive gate is the same invocation: it keeps the
  // invocation (and its checkout start) the paused attempt recorded.
  if (savedExecution !== undefined) ctx.nodeInvocation = savedExecution.invocation;
  const execution = beginExecution(ctx, node, {
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
  state.execution = execution;
  ctx.currentExecution = execution;
  const iterationEnv = { ...resolvedOptions?.env, ...aiNodeEnvironment(ctx, execution) };
  state.stopReason = undefined;
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
  if (typeof resume.gate?.commandSnapshot === 'string') {
    loopPromptTemplate = resume.gate.commandSnapshot;
  } else if (typeof loop.command === 'string') {
    const compiled = (loop as typeof loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND];
    const hasCompiledError = compiled !== undefined && typeof compiled.error === 'string';
    const hasCompiledPrompt = compiled !== undefined && typeof compiled.prompt === 'string';
    if (hasCompiledError && !hasCompiledPrompt) {
      getLog().error(
        { nodeId: node.id, command: loop.command, error: compiled.error },
        'loop_node.command_compilation_failed'
      );
      return failLoopNode(ctx, node.id, state, compiled.error, {
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
      return failLoopNode(ctx, node.id, state, errorMsg, {
        failureKind: 'config',
        data: { command: loop.command },
      });
    } else {
      const promptResult = await loadNodeCommandPrompt(ctx, loop.command, stepName);
      if (!promptResult.success) {
        getLog().error(
          { nodeId: node.id, command: loop.command, error: promptResult.message },
          'loop_node.command_load_failed'
        );
        return failLoopNode(ctx, node.id, state, promptResult.message, {
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

  const run: LoopRun = {
    ctx,
    node,
    stepName,
    msgContext,
    workflowProvider,
    resolvedOptions,
    aiClient,
    capabilities,
    iterationEnv,
    attemptEvents: createAttemptEventSequence(execution.attempt.id),
    promptTemplate: loopPromptTemplate,
    resume,
    retryConfig: getEffectiveNodeRetryConfig(node),
    checkpointSession,
  };
  const { startIteration, iterationLimit } = resume;
  for (let i = startIteration; i <= iterationLimit; i++) {
    const result = await runSettledLoopIteration(run, state, i);
    if (result !== undefined) return result;
  }

  // Max iterations exceeded
  const errorMsg = `Loop node '${node.id}' exceeded max iterations (${String(iterationLimit)}) ${describeUnmetCompletion(loop)}`;
  getLog().warn(
    { nodeId: node.id, maxIterations: iterationLimit, signal: loop.until },
    'loop_node.max_iterations_reached'
  );
  await safeSendMessage(platform, conversationId, errorMsg, msgContext);
  return failLoopNode(ctx, node.id, state, errorMsg, {
    failureKind: 'max_iterations',
    output: state.lastOutput,
    ...loopSpend(state),
    // A bare approve past the cap resumes beyond iterationLimit and runs nothing.
    loopIterations: Math.max(iterationLimit, startIteration - 1),
    data: { maxIterations: iterationLimit },
  });
}

/**
 * Run one iteration and settle a thrown iteration as a failed node carrying the spend
 * of the iterations already paid for.
 */
async function runSettledLoopIteration(
  run: LoopRun,
  state: LoopState,
  i: number
): Promise<NodeExecutionResult | undefined> {
  try {
    return await runLoopIteration(run, state, i);
  } catch (error) {
    // An iteration reads no node source, reserves no run budget and writes no terminal
    // status; a failed event write is the only engine error it can raise.
    if (error instanceof NodeEventWriteError) throw error;
    const { ctx, node } = run;
    const message = error instanceof Error ? error.message : String(error);
    getLog().error({ err: error, nodeId: node.id, iteration: i }, 'loop_node.execution_failed');
    const failed = await failLoopNode(ctx, node.id, state, message, {
      failureKind: 'unknown',
      ...loopSpend(state),
      loopIterations: state.lastStartedIteration,
      data: { iteration: i },
    });
    await safeSendMessage(
      ctx.platform,
      ctx.conversationId,
      `Loop node '${node.id}' failed: ${message}`,
      run.msgContext
    );
    return failed;
  }
}

function readLoopGate(
  workflowRun: WorkflowRun,
  node: LoopNode,
  execution: NodeExecutionRecord
): {
  gate: ApprovalContext | undefined;
  savedExecution: NodeExecutionRecord | undefined;
} {
  const savedApproval = workflowRun.metadata?.approval;
  let gate =
    isApprovalContext(savedApproval) &&
    savedApproval.type === 'interactive_loop' &&
    savedApproval.nodeId === node.id
      ? savedApproval
      : undefined;
  let savedExecution =
    gate?.execution === undefined ? undefined : nodeExecutionMetadataSchema.parse(gate.execution);
  if (
    savedExecution !== undefined &&
    nodeInvocationKey(savedExecution.path, savedExecution.invocation.loopPath) !==
      nodeInvocationKey(execution.path, execution.invocation.loopPath)
  ) {
    gate = undefined;
    savedExecution = undefined;
  }
  if (
    savedExecution !== undefined &&
    (savedExecution.runId !== workflowRun.id || savedExecution.node.kind !== 'loop')
  ) {
    throw new Error(
      `Loop execution identity does not match '${execution.path}' in run ${workflowRun.id}`
    );
  }
  return { gate, savedExecution };
}

function readLoopResume(
  workflowRun: WorkflowRun,
  node: LoopNode,
  execution: NodeExecutionRecord
): LoopResume & { savedExecution: NodeExecutionRecord | undefined } {
  const { gate, savedExecution } = readLoopGate(workflowRun, node, execution);
  const startIteration = gate !== undefined ? (gate.iteration ?? 0) + 1 : 1;
  const loopGateRunMeta = (workflowRun.metadata ?? {}) as LoopGateRunMetadata;
  const feedbackGiven = gate !== undefined && loopGateRunMeta.loop_feedback_given === true;
  const persistedUsageContext = { workflowRunId: workflowRun.id, nodeId: node.id };
  return {
    savedExecution,
    gate,
    startIteration,
    userInput: gate !== undefined ? (loopGateRunMeta.loop_user_input ?? '') : '',
    feedbackGiven,
    // Like a loop group: feedback on this node's gate authorizes one fresh iteration past the
    // autonomous bound; a bare approve does not.
    iterationLimit:
      gate !== undefined && feedbackGiven
        ? Math.max(node.loop.max_iterations, startIteration)
        : node.loop.max_iterations,
    costUsd:
      gate !== undefined
        ? readSignaledCostUsd(gate.signaledCostUsd, persistedUsageContext)
        : undefined,
    tokens:
      gate !== undefined
        ? readSignaledTokens(gate.signaledTokens, persistedUsageContext)
        : undefined,
  };
}

/**
 * Finalize-on-approve (#2074): a gate that paused on a completion-bearing iteration,
 * resumed WITHOUT feedback, completes the node from the persisted output instead of
 * re-running the (expensive) iteration. Feedback (loop_feedback_given) OR a
 * non-completing gate returns undefined and falls through to a normal resumed iteration.
 * Runs BEFORE prompt-source resolution: a bare approve never needs the prompt, so a
 * command file deleted while the run sat paused cannot fail the finalize.
 */
async function finalizeOnBareApprove(
  ctx: RunLayersContext,
  node: LoopNode,
  approval: {
    stepName: string;
    resume: LoopResume;
    savedExecution: NodeExecutionRecord | undefined;
    sessionId: string | undefined;
    checkpointSession: SessionCheckpoint | undefined;
  }
): Promise<NodeExecutionResult | undefined> {
  const { resume, sessionId } = approval;
  const gate = resume.gate;
  if (gate?.completionSignaled !== true || resume.feedbackGiven) return undefined;
  const finalizeOutput = gate.signaledOutput ?? '';
  // The signaled iteration's structured payload (#2637) — attached below so this
  // route matches natural completion's NodeOutput exactly. null/absent
  // (pre-#2637 gates) → text-only, as before.
  const finalizeStructured = gate.signaledStructuredOutput ?? null;
  if (sessionId !== undefined) {
    await approval.checkpointSession?.(sessionId);
  }
  return finalizeLoopFromSignal(
    ctx.deps,
    ctx.platform,
    ctx.conversationId,
    ctx.workflowRun,
    node,
    approval.stepName,
    'Loop node',
    finalizeOutput,
    {
      ...(resume.costUsd !== undefined ? { costUsd: resume.costUsd } : {}),
      ...(resume.tokens !== undefined ? { tokens: resume.tokens } : {}),
    },
    finalizeStructured ?? undefined,
    ctx.logDir,
    approval.savedExecution,
    sessionId
  );
}
