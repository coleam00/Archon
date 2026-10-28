import type { MessageChunk, ProviderFailure, TokenUsage } from '@archon/provider-contract';
import { sessionPreview } from '@archon/provider-contract';
import {
  type TurnCutOff,
  type WatchdogReset,
  STRUCTURED_OUTPUT_MAX_REASKS,
  structuredOutputPass,
  NodeFailure,
  providerReportedFailure,
} from '../../ai-turn';
import { DEFAULT_TOOL_CALL_ATTENTION_MS } from '../../../schemas/run-config';
import type { NodeExecutionResult } from '../../../node-record-serialization';
import type { NodeFailureKind } from '../../../schemas/node-execution';
import { createProviderEventHandler, type ProviderEventHandler } from '../../../provider-events';
import { createWatchdogResetRecorder, type WatchdogResetRecorder } from '../../../logger';
import { withIdleTimeout, STEP_IDLE_TIMEOUT_MS } from '../../../utils/idle-timeout';
import { isEndTurnRequested } from '../../../end-turn-request';
import { substituteWorkflowVariables } from '../../../workflow-variables';
import { writeNodeArtifactsListing } from '../../../artifacts-index';
import { stripCompletionTags } from '../../../executor-shared';
import { safeSendMessage } from '../../../platform-messages';
import { withStaleResumeRetry } from '../../../stale-resume';
import { getLog } from '../../log';
import { sumTokenUsage } from '../../usage';
import { resolveRunInputs, nodeTemplateReferences } from '../../references';
import { shouldContinueStreamingForStatus, CANCEL_CHECK_INTERVAL_MS } from '../../run-control';
import { failLoopNode, loopSpend, type LoopRun, type LoopState } from './loop-state';
import {
  failed,
  failedStream,
  gateStructuredAttempt,
  recordIterationFailed,
  retryOrFail,
} from './iteration-outcome';

/** The reply an iteration accepted: its raw prose and, with `output_format`, its validated payload. */
export interface IterationReply {
  kind: 'reply';
  /** Raw, for signal detection. */
  fullOutput: string;
  payload: unknown;
  /** The session this iteration reported, for its own `loop_iteration_completed` row. */
  sessionId: string | undefined;
}

export interface IterationFailed {
  kind: 'failed';
  result: NodeExecutionResult;
}

export type AttemptVerdict = { kind: 'retry' } | IterationFailed;

/** A failure the iteration's transient retry may absorb (#2706). */
export interface IterationFailure {
  failureKind: NodeFailureKind;
  error: string;
  providerFailure?: ProviderFailure;
}

/** The iteration's transient-retry position, shared by every attempt of one iteration. */
export interface IterationRetry {
  attempt: number;
  sawRateLimit: boolean;
}

/** The structured-output re-ask an attempt runs as: 0 is the iteration's own prompt. */
export interface Reask {
  attempt: number;
  errors: string[];
}

/** State one stream attempt accumulates; a reask or transient retry starts a fresh one. */
export interface StreamedAttempt {
  kind: 'streamed';
  fullOutput: string;
  /** What cut this attempt's stream off before it settled, if anything did. */
  cutOff: TurnCutOff | undefined;
  lastWatchdogReset: WatchdogReset | undefined;
  /** Whether this attempt's stream ended on the provider's `settled` (see the AI-node path's streamSettled). */
  settled: boolean;
  /** Raw structured payload seen on this attempt, before validation. */
  structured: unknown;
  /**
   * Status observed by the mid-stream check when it aborts (for the failure message);
   * undefined when the stream ends for any other reason.
   */
  stopStatus: string | undefined;
  abort: AbortController;
  providerEvents: ProviderEventHandler;
  /** Mid-stream cancel-check throttle (see the check inside the stream loop). */
  lastStatusCheckAt: number;
}

/**
 * This attempt's usage, folded into the loop totals exactly once — on both the normal
 * exit and the catch path (an SDK-error result still carries the attempt's cost, which
 * the totals reported on the failure return must include). Re-asked attempts each fold
 * their own cost, so an exhausted iteration reports what it spent.
 */
interface AttemptUsage {
  cost: number | undefined;
  tokens: TokenUsage | undefined;
  numTurns: number | undefined;
  folded: boolean;
}

type ResultChunk = Extract<MessageChunk, { type: 'result' }>;

/**
 * Stream one iteration's AI response.
 *
 * ── Structured-output attempts (#2563) ──────────────────────────────────
 * When the node declares `output_format`, an iteration is one or more STREAM
 * ATTEMPTS: the payload is validated against the schema, and on a best-effort
 * provider (Pi/Copilot) a miss is re-asked with the schema errors appended, up
 * to STRUCTURED_OUTPUT_MAX_REASKS. This mirrors executeAgentNode's contract
 * exactly, deliberately — a loop should not be the one node type where a
 * structured miss behaves differently. Exhaustion FAILS the node; it is never
 * treated as "not complete yet", which would be the silent degradation the
 * engine refuses everywhere else.
 *
 * Without `output_format` there is exactly one attempt.
 *
 * Per-attempt transient retry for AI-loop iterations (#2706): a plain AI node's
 * failure goes through runNodeRetryLoop; an iteration used to die on its first
 * TRANSIENT error (rate limit, silent stream death) and fail the whole node. Same
 * classification and delay policy, same widened rate-limit budget.
 */
export async function runIterationAttempts(
  run: LoopRun,
  state: LoopState,
  i: number,
  iterationStart: number
): Promise<IterationReply | IterationFailed> {
  const { ctx } = run;
  // Session threading: every attempt of this iteration resumes the session the previous
  // iteration ended in, never one a failed attempt reported.
  const needsFreshSession = run.node.loop.fresh_context || i === 1;
  const resumeSessionId = needsFreshSession ? undefined : state.sessionId;
  const retry: IterationRetry = { attempt: 0, sawRateLimit: false };
  for (; ; retry.attempt++) {
    if (retry.attempt > 0) {
      const status = await ctx.deps.store.getWorkflowRunStatus(ctx.workflowRun.id);
      if (!shouldContinueStreamingForStatus(status)) {
        return failed(
          await failLoopNode(ctx, run.node.id, state, `Workflow ${status ?? 'deleted'}`, {
            failureKind: 'cancelled',
            ...loopSpend(state),
            loopIterations: i - 1,
            data: { status: status ?? 'deleted', iteration: i },
          })
        );
      }
    }
    const outcome = await runReaskAttempts(run, state, i, iterationStart, {
      resumeSessionId,
      retry,
    });
    if (outcome.kind !== 'retry') return outcome;
  }
}

async function runReaskAttempts(
  run: LoopRun,
  state: LoopState,
  i: number,
  iterationStart: number,
  iteration: { resumeSessionId: string | undefined; retry: IterationRetry }
): Promise<IterationReply | AttemptVerdict> {
  const { retry } = iteration;
  // A failed attempt's session is not the one the iteration completed in. A reask
  // keeps the session the iteration's own prompt reported.
  const thread: { sessionId: string | undefined } = { sessionId: undefined };
  const reask: Reask = { attempt: 0, errors: [] };
  const wantsStructured = run.resolvedOptions?.outputFormat !== undefined;
  const maxReasks =
    wantsStructured && run.capabilities.structuredOutput === 'best-effort'
      ? STRUCTURED_OUTPUT_MAX_REASKS
      : 0;
  const reply = (attempt: StreamedAttempt, payload: unknown): IterationReply => ({
    kind: 'reply',
    fullOutput: attempt.fullOutput,
    payload,
    sessionId: thread.sessionId,
  });

  while (true) {
    const typedArtifactsFile = await writeNodeArtifactsListing(
      run.ctx.artifactsDir,
      run.ctx.workflowRun.id
    );
    const attempt = await streamIterationAttempt(
      run,
      state,
      i,
      iterationStart,
      typedArtifactsFile,
      { reask, thread, retry, resumeSessionId: iteration.resumeSessionId }
    );
    if (attempt.kind !== 'streamed') return attempt;
    const streamFailure = await failedStream(run, state, i, attempt, {
      wantsStructured,
      iterationStart,
      retry,
    });
    if (streamFailure !== undefined) return streamFailure;

    // ── Structured-output gate for this attempt ───────────────────────────
    // No `output_format` declared: one attempt, nothing to validate.
    if (!wantsStructured) return reply(attempt, undefined);
    const verdict = await gateStructuredAttempt(run, state, i, attempt, reask, maxReasks);
    if (verdict.kind === 'accepted') return reply(attempt, verdict.payload);
    if (verdict.kind === 'failed') return verdict;
    reask.attempt++;
    reask.errors = verdict.errors;
  }
}

function newAttempt(run: LoopRun): StreamedAttempt {
  const { ctx, node, stepName } = run;
  const attempt = {
    kind: 'streamed',
    fullOutput: '',
    cutOff: undefined,
    lastWatchdogReset: undefined,
    settled: false,
    structured: undefined,
    stopStatus: undefined,
    abort: new AbortController(),
    lastStatusCheckAt: Date.now(),
  } satisfies Omit<StreamedAttempt, 'providerEvents'>;
  const providerEvents = createProviderEventHandler({
    toolAttention: ctx.toolAttention.createStream({
      nodeId: stepName,
      reportedBackgroundWork: run.capabilities.backgroundWork === 'reported',
      provider: run.workflowProvider,
      thresholdMs: ctx.config.workflows?.toolCallAttentionMs ?? DEFAULT_TOOL_CALL_ATTENTION_MS,
      env: {
        ...(ctx.execContext.kind === 'host' ? process.env : {}),
        ...run.iterationEnv,
      },
      protectedEnvKeys: ctx.config.protectedEnvKeys,
      protectedCredentialValues: ctx.config.protectedCredentialValues,
    }),
    store: ctx.deps.store,
    platform: ctx.platform,
    conversationId: ctx.conversationId,
    messageContext: run.msgContext,
    logDir: ctx.logDir,
    runId: ctx.workflowRun.id,
    nodeId: node.id,
    stepName,
    attempt: run.attemptEvents,
    // A loop node takes no `mcp:` file, so no MCP failure is the workflow's own.
    configuredMcpServers: new Set(),
    onMessageText: async text => {
      streamed.fullOutput += text;
      if (ctx.platform.getStreamingMode() !== 'stream') return;
      const cleaned = stripCompletionTags(text, node.loop.until);
      if (cleaned) {
        await safeSendMessage(ctx.platform, ctx.conversationId, cleaned, run.msgContext);
      }
    },
  });
  const streamed: StreamedAttempt = { ...attempt, providerEvents };
  return streamed;
}

interface AttemptPosition {
  reask: Reask;
  thread: { sessionId: string | undefined };
  retry: IterationRetry;
  resumeSessionId: string | undefined;
}

async function streamIterationAttempt(
  run: LoopRun,
  state: LoopState,
  i: number,
  iterationStart: number,
  typedArtifactsFile: string,
  position: AttemptPosition
): Promise<StreamedAttempt | AttemptVerdict> {
  const { ctx, node } = run;
  // A reask re-runs the stream, so anything the stream accumulates or aborts must start
  // clean or a prior attempt's prose would leak into this one's output and signal detection.
  const attempt = newAttempt(run);
  const usage: AttemptUsage = {
    cost: undefined,
    tokens: undefined,
    numTurns: undefined,
    folded: false,
  };
  const watchdogResets = createWatchdogResetRecorder(
    ctx.logDir,
    ctx.workflowRun.id,
    `${node.id}-iteration-${String(i)}`
  );

  try {
    await consumeIterationStream(run, state, i, typedArtifactsFile, {
      attempt,
      usage,
      watchdogResets,
      position,
    });
    foldIterationUsage(state, usage, node.id);
    recordDanglingTasks(run, state, i, attempt);
  } catch (error) {
    foldIterationUsage(state, usage, node.id);
    const err = error as Error;
    getLog().error({ err, nodeId: node.id, iteration: i }, 'loop_node.iteration_failed');
    recordIterationFailed(run, i, err.message, Date.now() - iterationStart);
    return await retryOrFail(
      run,
      state,
      i,
      {
        failureKind: err instanceof NodeFailure ? err.kind : 'unknown',
        error: err.message,
        ...(err instanceof NodeFailure && err.providerFailure !== undefined
          ? { providerFailure: err.providerFailure }
          : {}),
      },
      position.retry
    );
  } finally {
    await watchdogResets.flush();
  }
  return attempt;
}

function foldIterationUsage(state: LoopState, usage: AttemptUsage, nodeId: string): void {
  if (usage.folded) return;
  usage.folded = true;
  if (usage.cost !== undefined) {
    state.costUsd = (state.costUsd ?? 0) + usage.cost;
  }
  if (!state.tokensUnknown && usage.tokens !== undefined) {
    state.tokens = sumTokenUsage(
      [...(state.tokens !== undefined ? [state.tokens] : []), usage.tokens],
      { nodeId }
    );
  }
  if (usage.numTurns !== undefined) {
    state.numTurns = (state.numTurns ?? 0) + usage.numTurns;
  }
}

/**
 * Stream ended with background tasks still live (idle timeout mid-wait, operator cutoff or subprocess
 * death): their artifacts may be missing (#2083). Record them for the audit trail
 * whatever ended the stream; the operator hears about it once, from the iteration's
 * unsettled failure, which names these tasks.
 */
function recordDanglingTasks(
  run: LoopRun,
  state: LoopState,
  i: number,
  attempt: StreamedAttempt
): void {
  const danglingTaskIds = attempt.providerEvents.liveSubtaskIds();
  if (danglingTaskIds.length === 0) return;
  for (const id of danglingTaskIds) state.backgroundTasksIncomplete.add(id);
  getLog().warn(
    {
      nodeId: run.node.id,
      iteration: i,
      taskIds: danglingTaskIds,
      cutOff: attempt.cutOff,
      cancelled: attempt.abort.signal.aborted && !attempt.cutOff,
    },
    'loop_node.iteration_stream_ended_with_live_background_tasks'
  );
}

interface StreamScope {
  attempt: StreamedAttempt;
  usage: AttemptUsage;
  watchdogResets: WatchdogResetRecorder;
  position: AttemptPosition;
}

/** The prompt one attempt sends: the iteration's template, plus the schema errors on a reask. */
function attemptPrompt(
  run: LoopRun,
  state: LoopState,
  i: number,
  typedArtifactsFile: string,
  reask: Reask
): string {
  const { ctx } = run;
  // Build prompt — substituteWorkflowVariables throws if $BASE_BRANCH referenced but empty
  // Pass loopUserInput on the first resumed iteration; '' on all others (non-interactive
  // or subsequent iterations) so $LOOP_USER_INPUT substitutes to empty string explicitly.
  // $LOOP_PREV_OUTPUT carries the previous iteration's cleaned output and is empty on
  // the first iteration (no prior output exists).
  const { prompt: basePrompt } = substituteWorkflowVariables(
    run.promptTemplate,
    ctx.workflowRun.id,
    ctx.workflowRun.user_message,
    ctx.artifactsDir,
    ctx.baseBranch,
    ctx.docsDir,
    ctx.issueContext,
    i === run.resume.startIteration ? run.resume.userInput : '',
    undefined, // rejectionReason
    state.lastOutput,
    {
      stateDir: ctx.stateDir,
      inputs: resolveRunInputs(ctx.workflowRun),
      typedArtifactsFile,
      references: nodeTemplateReferences(run.promptTemplate, ctx),
    }
  );
  // A reask re-runs this iteration's prompt with the schema errors appended, so
  // the model is told WHAT was wrong rather than silently asked again.
  return reask.attempt === 0
    ? basePrompt
    : `${basePrompt}\n\n---\n\nYour previous response did not match the required output schema:\n${reask.errors.map(e => `- ${e}`).join('\n')}\n\nRespond again with output that satisfies the schema exactly.`;
}

async function consumeIterationStream(
  run: LoopRun,
  state: LoopState,
  i: number,
  typedArtifactsFile: string,
  scope: StreamScope
): Promise<void> {
  const { ctx, node, capabilities } = run;
  const { attempt, watchdogResets } = scope;
  const { providerEvents } = attempt;
  const finalPrompt = attemptPrompt(run, state, i, typedArtifactsFile, scope.position.reask);
  const pass = structuredOutputPass(
    scope.position.reask.attempt,
    scope.position.resumeSessionId,
    false
  );
  const generator = withStaleResumeRetry(
    resumeSessionId =>
      run.aiClient.sendQuery(finalPrompt, ctx.cwd, resumeSessionId, {
        ...run.resolvedOptions,
        env: run.iterationEnv,
        abortSignal: attempt.abort.signal,
      }),
    pass.resumeSessionId,
    {
      logContext: { workflowRunId: ctx.workflowRun.id, nodeId: node.id, iteration: i },
      onRetry: async () => {
        await safeSendMessage(
          ctx.platform,
          ctx.conversationId,
          `⚠️ Loop \`${node.id}\` iteration ${String(i)}: could not resume the previous iteration's session — continued with a fresh session, so the earlier context was not restored.`,
          run.msgContext
        );
      },
    }
  );
  const effectiveIdleTimeout = node.idle_timeout ?? STEP_IDLE_TIMEOUT_MS;
  const shouldStopStream = (): Promise<boolean> => stopStreamIfRunStopped(run, i, attempt);
  try {
    for await (const msg of withIdleTimeout(
      generator,
      effectiveIdleTimeout,
      () => {
        attempt.cutOff = {
          kind: 'idle_timeout',
          timeoutMs: effectiveIdleTimeout,
          lastReset: attempt.lastWatchdogReset,
        };
        getLog().warn(
          {
            nodeId: node.id,
            iteration: i,
            timeoutMs: effectiveIdleTimeout,
            ...(attempt.lastWatchdogReset
              ? {
                  lastResetType: attempt.lastWatchdogReset.type,
                  lastResetAt: new Date(attempt.lastWatchdogReset.at).toISOString(),
                }
              : {}),
          },
          'loop_node.idle_timeout_reached'
        );
        attempt.abort.abort();
      },
      (msg, resetAt) => {
        const type = msg.type;
        attempt.lastWatchdogReset = { type, at: resetAt };
        watchdogResets.observe(type, resetAt);
      },
      () =>
        providerEvents.hasOpenTools() ||
        (capabilities.backgroundWork === 'reported' && providerEvents.liveSubtaskIds().length > 0),
      shouldStopStream
    )) {
      // A result is not the end of the iteration; `settled` is. See the
      // AI-node stream loop for the full rationale.
      if (msg.type === 'result') applyResultChunk(run, state, i, scope, pass.threadsSession, msg);
      else if (msg.type !== 'settled') await providerEvents.handle(msg);
      const stopped = await shouldStopStream();
      if (msg.type === 'result' && (!stopped || attempt.cutOff)) throwOnResultFailure(run, i, msg);
      if (stopped) break;

      if (msg.type === 'settled') {
        attempt.settled =
          capabilities.backgroundWork !== 'reported' ||
          providerEvents.liveSubtaskIds().length === 0;
        break;
      }
    }
  } finally {
    await providerEvents.clearAttention();
  }
}

/**
 * Mid-stream cancel check. A local timestamp rather than the module-level
 * lastNodeCancelCheck map the AI node uses: the loop owns its whole lifecycle in one
 * call stack, so a local needs no per-return-path map cleanup.
 */
async function stopStreamIfRunStopped(
  run: LoopRun,
  i: number,
  attempt: StreamedAttempt
): Promise<boolean> {
  const { ctx, node } = run;
  await ctx.toolAttention.refresh();
  await attempt.providerEvents.refreshAttention();
  const tickNow = Date.now();
  if (tickNow - attempt.lastStatusCheckAt <= CANCEL_CHECK_INTERVAL_MS) return false;
  attempt.lastStatusCheckAt = tickNow;
  try {
    const streamStatus = await ctx.deps.store.getWorkflowRunStatus(ctx.workflowRun.id);
    if (!shouldContinueStreamingForStatus(streamStatus)) {
      attempt.stopStatus = streamStatus ?? 'deleted';
      getLog().info(
        {
          workflowRunId: ctx.workflowRun.id,
          nodeId: node.id,
          iteration: i,
          status: attempt.stopStatus,
        },
        'loop_node.stop_detected_during_streaming'
      );
      attempt.abort.abort();
      return true;
    }
    if (await operatorEndedIteration(run, i, attempt)) {
      attempt.cutOff = { kind: 'operator' };
      attempt.abort.abort();
      return true;
    }
  } catch (statusErr) {
    getLog().warn(
      { err: statusErr as Error, workflowRunId: ctx.workflowRun.id, nodeId: node.id },
      'loop_node.status_check_failed'
    );
  }
  return false;
}

/** Whether the operator ended this attempt's turn while it had stalled calls raised. */
async function operatorEndedIteration(
  run: LoopRun,
  i: number,
  attempt: StreamedAttempt
): Promise<boolean> {
  const stall = attempt.providerEvents.stall();
  if (stall === undefined) return false;
  const runId = run.ctx.workflowRun.id;
  if (!(await isEndTurnRequested(run.ctx.deps.store, runId, stall))) return false;
  getLog().warn(
    { workflowRunId: runId, nodeId: run.node.id, iteration: i },
    'loop_node.turn_ended_by_operator'
  );
  return true;
}

function applyResultChunk(
  run: LoopRun,
  state: LoopState,
  i: number,
  scope: StreamScope,
  threadsSession: boolean,
  msg: ResultChunk
): void {
  threadResultSession(run, state, i, scope.position, threadsSession, msg);
  addResultUsage(run, state, i, scope.usage, msg);
  if (msg.stopReason !== undefined) state.stopReason = msg.stopReason;
  // Unconditional, for the same reason as the AI-node path: a later iteration or result
  // chunk that reports no resolved model must clear the previous one rather than leave
  // it to be recorded as this node's answer.
  state.resolvedModel = msg.resolvedModel;
  if (msg.text !== undefined) {
    scope.attempt.fullOutput = msg.text;
  }
  scope.attempt.structured = msg.structuredOutput;
}

/**
 * A reask's throwaway session is not the thread (structuredOutputPass): adopting it
 * would silently discard iterations 1…N and break the `fresh_context: false` contract
 * ("each iteration resumes the prior conversation"). The repaired answer still reaches
 * the next iteration through $LOOP_PREV_OUTPUT, which is prompt text rather than
 * session state.
 */
function threadResultSession(
  run: LoopRun,
  state: LoopState,
  i: number,
  position: AttemptPosition,
  threadsSession: boolean,
  msg: ResultChunk
): void {
  if (threadsSession) {
    state.sessionId = msg.sessionId;
    position.thread.sessionId = msg.sessionId;
  } else if (msg.sessionId && state.sessionId !== msg.sessionId) {
    getLog().debug(
      {
        nodeId: run.node.id,
        iteration: i,
        attempt: position.reask.attempt,
        ...(state.sessionId !== undefined
          ? { keptSessionIdPreview: sessionPreview(state.sessionId) }
          : {}),
      },
      'loop_node.reask_session_not_threaded'
    );
  }
}

function addResultUsage(
  run: LoopRun,
  state: LoopState,
  i: number,
  usage: AttemptUsage,
  msg: ResultChunk
): void {
  const nodeId = run.node.id;
  if (msg.cost !== undefined) {
    if (Number.isFinite(msg.cost)) {
      usage.cost = (usage.cost ?? 0) + msg.cost;
    } else {
      getLog().warn(
        { nodeId, iteration: i, costUsd: msg.cost },
        'loop_node.usage_cost_non_finite_ignored'
      );
    }
  }
  state.tokensUnknown ||= msg.tokensUnknown === true;
  if (state.tokensUnknown) {
    usage.tokens = undefined;
    state.tokens = undefined;
  } else if (msg.tokens !== undefined) {
    usage.tokens = sumTokenUsage([...(usage.tokens ? [usage.tokens] : []), msg.tokens], {
      nodeId,
      iteration: i,
    });
  }
  if (msg.numTurns !== undefined) {
    usage.numTurns = msg.numTurns;
  }
}

function throwOnResultFailure(run: LoopRun, i: number, msg: ResultChunk): void {
  const nodeId = run.node.id;
  if (msg.failure !== undefined) {
    throw providerReportedFailure(
      `Loop '${nodeId}' iteration ${String(i)}`,
      msg.failure,
      run.resolvedOptions?.maxBudgetUsd,
      { nodeId, iteration: i }
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
  if (!msg.isError || msg.errorSubtype === 'success') return;
  const subtype = msg.errorSubtype ?? 'unknown';
  const errorsDetail = msg.errors?.length ? ` — ${msg.errors.join('; ')}` : '';
  getLog().error(
    {
      nodeId,
      iteration: i,
      errorSubtype: subtype,
      errors: msg.errors,
      ...(msg.sessionId ? { sessionIdPreview: sessionPreview(msg.sessionId) } : {}),
      stopReason: msg.stopReason,
    },
    'loop_node.iteration_sdk_error'
  );
  throw new Error(
    `Loop '${nodeId}' iteration ${String(i)} failed: SDK returned ${subtype}${errorsDetail}`
  );
}
