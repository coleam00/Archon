import {
  type WatchdogReset,
  formatWatchdogResetDiagnostic,
  STRUCTURED_OUTPUT_MAX_REASKS,
  structuredOutputPass,
  unsettledTurnError,
  NodeFailure,
  providerReportedFailure,
} from '../../ai-turn';
import {
  buildHonestGateMessage,
  finalizeLoopFromSignal,
  type LoopCompletionCheck,
} from '../../loop-completion';
import { pauseGateRespectingExternalTransition, sendPauseNotice } from '../../pause';
import { hostSpawnFailure, type RawSubprocessRejection } from '../../../subprocess';
import { DEFAULT_TOOL_CALL_ATTENTION_MS } from '../../../schemas/run-config';
import { requireProvider } from '@archon/provider-contract';
import { finishNodeExecution, executionMetadata } from '../../../node-execution';
import {
  serializeNodeStateRecord,
  serializeDeferredNodeUsage,
  serializeNodeOutput,
  type NodeExecutionResult,
} from '../../../node-record-serialization';
import {
  nodeExecutionMetadataSchema,
  type NodeExecutionRecord,
  type NodeFailureKind,
} from '../../../schemas/node-execution';
import {
  persistNodeEvent,
  recordDerivedExecution,
  recordNodeState,
} from '../../../node-event-write';
import { resolveBashPath } from '@archon/git';
import { spellWorkflowCommand } from '../../../deps';
import type {
  SendQueryOptions,
  ProviderCapabilities,
  TokenUsage,
  ResolvedModel,
} from '@archon/provider-contract';
import { sessionPreview, type ProviderFailure } from '@archon/provider-contract';
import { gateOccurrence } from '../../../schemas/workflow-run';
import { validateStructuredOutput } from '../../../structured-output';
import type { LoopNode, EffortLevel, LoopGateRunMetadata, ApprovalContext } from '../../../schemas';
import { isApprovalContext } from '../../../schemas';
import {
  createAttemptEventSequence,
  createProviderEventHandler,
  type ProviderEventHandler,
} from '../../../provider-events';
import { getWorkflowEventEmitter } from '../../../event-emitter';
import { declaredOutputPathsFromSchema, canonicalValueText } from '../../../output-ref';
import { writeNodeArtifactsListing } from '../../../artifacts-index';
import {
  COMPILED_LOOP_COMMAND,
  resolveIncludeOutputAliases,
  type LoopWithCompiledCommand,
} from '../../../compiled-command';
import { logNodeComplete, createWatchdogResetRecorder } from '../../../logger';
import { withIdleTimeout, STEP_IDLE_TIMEOUT_MS } from '../../../utils/idle-timeout';
import {
  retryClassOf,
  currentAdoptedRunDir,
  getRetryDelayMs,
  effectiveRetryMaxRetries,
  substituteWorkflowVariables,
  detectCompletionSignal,
  describeUnmetCompletion,
  stripCompletionTags,
  safeSendMessage,
} from '../../../executor-shared';
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
import {
  resolveRunInputs,
  nodeTemplateReferences,
  buildNodeShellEnvironment,
} from '../../references';
import { rejectedArtifactPointer } from '../../node-output';
import {
  shouldContinueStreamingForStatus,
  waitForNodeRetry,
  CANCEL_CHECK_INTERVAL_MS,
  runSubprocessUntilRunStops,
} from '../../run-control';
import { getEffectiveNodeRetryConfig } from '../../retry';

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

  // A resumed loop continues from the paused iteration, so its output stays the
  // previous output for $LOOP_PREV_OUTPUT and until_bash.
  let lastIterationOutput = isLoopResume ? (loopGateMeta.iterationOutput ?? '') : '';
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
  // executeAgentNode).
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
    // to STRUCTURED_OUTPUT_MAX_REASKS. This mirrors executeAgentNode's contract
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
            if (platform.getStreamingMode() !== 'stream') return;
            const cleaned = stripCompletionTags(text, loop.until);
            if (cleaned) {
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
          // the first iteration (no prior output exists).
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
            lastIterationOutput,
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
        // contract as the single-shot AI-node guard in executeAgentNode. A
        // provider stream that closed cleanly with zero content typically means
        // a silent rejection or interruption; left unchecked, an interactive
        // loop would pause with a blank gate or burn the full max_iterations
        // budget producing nothing. A timeout before any output is the same
        // failure as on a single-shot AI node, so it enters the transient retry
        // path instead of consuming an iteration.
        //
        // A structured payload is also exempt (#2563), matching the agent node's
        // empty-output guard, which also requires `structuredOutput === undefined`: with
        // grammar-constrained decoding the assistant prose is routinely EMPTY because
        // the whole answer arrived as the payload. Failing that would make every
        // Claude/Codex structured loop fail on iteration 1.
        //
        // A timed-out `output_format` iteration is exempt too: the structured branch
        // below owns it, naming the contract that failed and failing on the first
        // attempt. That mirrors executeAgentNode, where this generic guard is
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
        // finished (see executeAgentNode). A timed-out `output_format` iteration is
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
        // miss — never spend a reask on it (mirrors the agent node's canReask).
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

    // Stripped from the whole reply: a completion tag can span reply blocks, and each
    // block's own whitespace is part of the text.
    const cleanOutput = stripCompletionTags(fullOutput, loop.until);
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
        if (hostSpawnFailure(execContext, bashErr) !== undefined) {
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
        iterationOutput: lastIterationOutput,
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
