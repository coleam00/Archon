import { LOOP_COMPLETION_CHANNELS, type LoopCompletionChannel } from '../../../schemas/loop';
import { bashInvocation } from '../../../bash-invocation';
import { resolveBashPath } from '@archon/git';
import { buildHonestGateMessage, type LoopCompletionCheck } from '../../loop-completion';
import {
  runOrStagePause,
  pauseGateRespectingExternalTransition,
  sendPauseNotice,
  snapshotBodySessionCursorAncestry,
} from '../../pause';
import { hostSpawnFailure, type RawSubprocessRejection } from '../../../subprocess';
import { finishNodeExecution, executionMetadata } from '../../../node-execution';
import {
  serializeNodeStateRecord,
  serializeDeferredNodeUsage,
  serializeNodeOutput,
  type NodeExecutionResult,
} from '../../../node-record-serialization';
import {
  persistNodeEvent,
  recordDerivedExecution,
  recordNodeState,
} from '../../../node-event-write';
import { spellWorkflowCommand } from '../../../deps';
import { gateOccurrence } from '../../../schemas/workflow-run';
import type { ApprovalContext } from '../../../schemas';
import { getWorkflowEventEmitter } from '../../../event-emitter';
import { declaredOutputPathsFromSchema, canonicalValueText } from '../../../output-ref';
import { writeNodeArtifactsListing } from '../../../artifacts-index';
import { logNodeComplete } from '../../../logger';
import { currentAdoptedRunDir, substituteWorkflowVariables } from '../../../workflow-variables';
import { detectCompletionSignal, stripCompletionTags } from '../../../executor-shared';
import { safeSendMessage } from '../../../platform-messages';
import { getLog } from '../../log';
import { nodeTemplateReferences, buildNodeShellEnvironment } from '../../references';
import { shouldContinueStreamingForStatus, runSubprocessUntilRunStops } from '../../run-control';
import {
  failLoopNode,
  logIterationEventError,
  loopSpend,
  type LoopRun,
  type LoopState,
} from './loop-state';
import {
  runIterationAttempts,
  type IterationFailed,
  type IterationReply,
} from './iteration-stream';

/**
 * Run one loop iteration. Returns the node's result when the iteration ends the node —
 * a stop, a failure, completion or an interactive gate — and undefined when the loop
 * goes on to the next iteration.
 */
export async function runLoopIteration(
  run: LoopRun,
  state: LoopState,
  i: number
): Promise<NodeExecutionResult | undefined> {
  const { ctx, node } = run;
  const loop = node.loop;
  const iterationStart = Date.now();

  const stopped = await stopBeforeIteration(run, state, i);
  if (stopped !== undefined) return stopped;
  state.lastStartedIteration = i;
  recordIterationStarted(run, i);

  const reply = await runIterationAttempts(run, state, i, iterationStart);
  if (reply.kind === 'failed') return reply.result;
  const accepted = await acceptIterationReply(run, state, i, reply);
  if (accepted.kind === 'failed') return accepted.result;

  const completionChecks = await checkCompletion(run, state, i, {
    reply,
    structuredText: accepted.structuredText,
    prevIterationOutput: accepted.prevIterationOutput,
  });
  if (!Array.isArray(completionChecks)) return completionChecks.result;

  const duration = Date.now() - iterationStart;
  const completionDetected = completionChecks.some(check => check.completed);
  recordIterationCompleted(run, i, { duration, completionDetected, sessionId: reply.sessionId });
  await logNodeComplete(
    ctx.logDir,
    ctx.workflowRun.id,
    `${node.id}-iteration-${String(i)}`,
    node.id,
    { durationMs: duration }
  );

  // A completion channel fired — exit the loop.
  // For interactive loops: only honor completion when the AI had user input to evaluate
  // (i.e., this is a resume iteration with loopUserInput). On the first iteration of a
  // fresh interactive loop, the user hasn't seen anything yet — always gate first,
  // UNLESS the author opted into autonomous completion via signal_completes (#2074).
  // For non-interactive loops: any declared channel can complete the iteration.
  const interactiveFirstRun = loop.interactive && run.resume.gate === undefined;
  const signalCompletes = loop.signal_completes === true;
  if (completionDetected && (!interactiveFirstRun || signalCompletes)) {
    return completeLoop(run, state, i);
  }

  // Interactive loop gate — pause after an iteration that did not complete (or, when
  // interactiveFirstRun && !signalCompletes, an iteration that DID complete — the honest
  // status line + persisted completion state (#2074) let a bare approve finalize it).
  // On a non-completing gate, the user's feedback feeds the next iteration, which exits
  // above once any declared completion channel fires.
  if (loop.interactive && loop.gate_message) {
    await ctx.interactionAdmission?.beforeInteraction();
    const origin = ctx.interactionAdmission?.failure();
    if (origin !== undefined) return suppressLoopGate(run, state, i, origin);
    const honestMessage = buildHonestGateMessage(
      completionChecks,
      state.lastOutput,
      loop.gate_message
    );
    return pauseAtLoopGate(run, state, i, { honestMessage, completionDetected });
  }
  return undefined;
}

/**
 * Check for non-running status between iterations. `paused` is tolerated
 * here for the same reason as the streaming check: a sibling approval
 * node in the same topological layer may pause the run while this loop
 * is between iterations — the loop should continue its own iterations
 * regardless of unrelated pauses elsewhere in the DAG.
 */
async function stopBeforeIteration(
  run: LoopRun,
  state: LoopState,
  i: number
): Promise<NodeExecutionResult | undefined> {
  const { ctx, node } = run;
  const runStatus = await ctx.deps.store.getWorkflowRunStatus(ctx.workflowRun.id);
  if (shouldContinueStreamingForStatus(runStatus)) return undefined;
  const effectiveStatus = runStatus ?? 'deleted';
  getLog().info(
    { workflowRunId: ctx.workflowRun.id, nodeId: node.id, iteration: i, status: effectiveStatus },
    'loop_node.stop_detected'
  );
  await safeSendMessage(
    ctx.platform,
    ctx.conversationId,
    `Loop node '${node.id}' stopped at iteration ${String(i)} (${effectiveStatus})`,
    run.msgContext
  );
  return failLoopNode(ctx, node.id, state, `Workflow ${effectiveStatus}`, {
    failureKind: 'cancelled',
    ...loopSpend(state),
    loopIterations: i - 1,
    data: { status: effectiveStatus, iteration: i },
  });
}

function recordIterationStarted(run: LoopRun, i: number): void {
  const { ctx, node } = run;
  const maxIterations = run.resume.iterationLimit;
  getWorkflowEventEmitter().emit({
    type: 'loop_iteration_started',
    runId: ctx.workflowRun.id,
    nodeId: node.id,
    iteration: i,
    maxIterations,
  });
  ctx.deps.store
    .createWorkflowEvent({
      workflow_run_id: ctx.workflowRun.id,
      event_type: 'loop_iteration_started',
      step_name: run.stepName,
      data: { iteration: i, maxIterations, nodeId: node.id },
    })
    .catch((err: Error) => {
      logIterationEventError(node.id, err, i);
    });
}

/**
 * Make the accepted reply the loop's last output. With `output_format` the serialized
 * payload — not the prose — is the node's output, so `$loop.output.field`,
 * `$LOOP_PREV_OUTPUT` and the gate excerpt all read the same validated value (mirrors
 * the AI node).
 */
async function acceptIterationReply(
  run: LoopRun,
  state: LoopState,
  i: number,
  reply: IterationReply
): Promise<
  | { kind: 'accepted'; structuredText: string | undefined; prevIterationOutput: string }
  | IterationFailed
> {
  const { ctx, node } = run;
  let structuredText: string | undefined;
  if (reply.payload !== undefined) {
    try {
      structuredText = canonicalValueText(reply.payload);
    } catch (serializeErr) {
      const err = serializeErr as Error;
      return {
        kind: 'failed',
        result: await failLoopNode(
          ctx,
          node.id,
          state,
          `Loop node '${node.id}': failed to serialize structured_output to JSON: ${err.message}`,
          {
            failureKind: 'output_contract',
            ...loopSpend(state),
            loopIterations: i,
            data: { iteration: i },
          }
        ),
      };
    }
    state.lastStructuredOutput = reply.payload;
  }

  // Stripped from the whole reply: a completion tag can span reply blocks, and each
  // block's own whitespace is part of the text.
  const cleanOutput = stripCompletionTags(reply.fullOutput, node.loop.until);
  // Batch mode: send accumulated output
  const batchContent = structuredText ?? cleanOutput;
  if (ctx.platform.getStreamingMode() === 'batch' && batchContent) {
    await safeSendMessage(ctx.platform, ctx.conversationId, batchContent, run.msgContext);
  }

  const prevIterationOutput = state.lastOutput;
  state.lastOutput = structuredText ?? (cleanOutput || reply.fullOutput);
  return { kind: 'accepted', structuredText, prevIterationOutput };
}

/** Completion channels, cheapest first; each declared channel reports whether it fired. */
async function checkCompletion(
  run: LoopRun,
  state: LoopState,
  i: number,
  iteration: {
    reply: IterationReply;
    structuredText: string | undefined;
    prevIterationOutput: string;
  }
): Promise<LoopCompletionCheck[] | IterationFailed> {
  const loop = run.node.loop;
  const { reply, structuredText } = iteration;
  const payload = reply.payload;
  const completionChecks: LoopCompletionCheck[] = [];
  // Field checks precede signals for gate attribution; bash runs last so a cheaper
  // completed channel can suppress its potentially side-effecting subprocess.
  const channels = [
    ...LOOP_COMPLETION_CHANNELS.filter(({ field }) => field === 'until_field'),
    ...LOOP_COMPLETION_CHANNELS.filter(({ field }) => field !== 'until_field'),
  ];
  async function evaluateChannel(
    field: LoopCompletionChannel
  ): Promise<LoopCompletionCheck | IterationFailed | undefined> {
    switch (field) {
      case 'until_field':
        if (loop.until_field === undefined) break;
        return {
          channel: field,
          field: loop.until_field,
          completed:
            payload !== null &&
            typeof payload === 'object' &&
            (payload as Record<string, unknown>)[loop.until_field] === true,
        };
      case 'until':
        if (loop.until === undefined) break;
        // Separate haystacks preserve detection of a signal on the final prose
        // line even when grammar-constrained output also supplies a payload.
        return {
          channel: field,
          signal: loop.until,
          completed:
            detectCompletionSignal(reply.fullOutput, loop.until) ||
            (structuredText !== undefined && detectCompletionSignal(structuredText, loop.until)),
        };
      case 'until_bash': {
        if (loop.until_bash === undefined) break;
        let completed = false;
        if (!completionChecks.some(check => check.completed)) {
          const bash = await runUntilBash(run, state, i, loop.until_bash, iteration);
          if (typeof bash !== 'boolean') return bash;
          completed = bash;
        }
        return { channel: field, completed };
      }
      default: {
        const unhandled: never = field;
        return unhandled;
      }
    }
    return undefined;
  }
  for (const { field } of channels) {
    const check = await evaluateChannel(field);
    if (check === undefined) continue;
    if ('kind' in check) return check;
    completionChecks.push(check);
  }
  return completionChecks;
}

/** Run until_bash: exit 0 completes the iteration, any other exit code keeps looping. */
async function runUntilBash(
  run: LoopRun,
  state: LoopState,
  i: number,
  untilBash: string,
  iteration: { prevIterationOutput: string }
): Promise<boolean | IterationFailed> {
  const { ctx, node } = run;
  const { workflowRun, artifactsDir, stateDir, logDir, baseBranch, config, execContext } = ctx;
  // Resolve outside the try so ARCHON_BASH_PATH validation errors bubble up
  // to the caller instead of being swallowed by the per-iteration catch.
  const loopBashPath = resolveBashPath();
  const typedArtifactsFile = await writeNodeArtifactsListing(artifactsDir, workflowRun.id);
  try {
    const { prompt: substitutedBash } = substituteWorkflowVariables(
      untilBash,
      workflowRun.id,
      workflowRun.user_message,
      artifactsDir,
      baseBranch,
      ctx.docsDir,
      ctx.issueContext,
      undefined,
      undefined,
      undefined,
      {
        shellSafe: true,
        stateDir,
        typedArtifactsFile,
        references: nodeTemplateReferences(untilBash, ctx, 'shell', {
          artifactsDir,
          requiredContext: { consumerId: node.id, field: 'loop.until_bash' },
        }),
      }
    );
    const invocation = bashInvocation(substitutedBash);
    await runSubprocessUntilRunStops(
      ctx.deps.store,
      workflowRun.id,
      node.id,
      execContext,
      loopBashPath,
      invocation.args,
      {
        input: invocation.input,
        cwd: ctx.cwd,
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
          loopUserInput: i === run.resume.startIteration ? run.resume.userInput : '',
          loopPrevOutput: iteration.prevIterationOutput,
          rejectionReason: '',
          issueContext: ctx.issueContext,
          adoptedRunDir: currentAdoptedRunDir(),
          typedArtifactsFile,
          nodeExecution: state.execution,
        }),
      }
    );
    return true; // exit 0 = complete
  } catch (e) {
    return untilBashRejected(run, state, i, e as RawSubprocessRejection, loopBashPath);
  }
}

async function untilBashRejected(
  run: LoopRun,
  state: LoopState,
  i: number,
  bashErr: RawSubprocessRejection,
  loopBashPath: string
): Promise<false | IterationFailed> {
  const { ctx, node } = run;
  if (bashErr.cancelled) {
    return {
      kind: 'failed',
      result: await failLoopNode(ctx, node.id, state, bashErr.message, {
        failureKind: 'cancelled',
        ...loopSpend(state),
        loopIterations: i,
        data: { iteration: i },
      }),
    };
  }
  // System-level errors (ENOENT/EACCES/ENOTDIR) mean the bash binary itself
  // is unreachable — looping forever on bashComplete=false is wrong. Throw
  // out of the loop with a clear actionable error instead.
  if (hostSpawnFailure(ctx.execContext, bashErr) !== undefined) {
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
  return false;
}

function recordIterationCompleted(
  run: LoopRun,
  i: number,
  completed: { duration: number; completionDetected: boolean; sessionId: string | undefined }
): void {
  const { ctx, node } = run;
  const { duration, completionDetected, sessionId } = completed;
  getWorkflowEventEmitter().emit({
    type: 'loop_iteration_completed',
    runId: ctx.workflowRun.id,
    nodeId: node.id,
    iteration: i,
    duration,
    completionDetected,
  });
  ctx.deps.store
    .createWorkflowEvent({
      workflow_run_id: ctx.workflowRun.id,
      event_type: 'loop_iteration_completed',
      step_name: run.stepName,
      data: {
        iteration: i,
        duration,
        completionDetected,
        nodeId: node.id,
        // The durable row is the only home for the full id; the emitter event above
        // and the transcript line stay without it.
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      },
    })
    .catch((err: Error) => {
      logIterationEventError(node.id, err, i);
    });
}

async function completeLoop(
  run: LoopRun,
  state: LoopState,
  i: number
): Promise<NodeExecutionResult> {
  const { ctx, node } = run;
  if (state.sessionId !== undefined) {
    await run.checkpointSession?.(state.sessionId);
  }
  await safeSendMessage(
    ctx.platform,
    ctx.conversationId,
    `Loop node '${node.id}' completed after ${String(i)} iteration${i > 1 ? 's' : ''}`,
    run.msgContext
  );
  // Write node_completed event so resume hydration knows this
  // node is done. Without this, a resumed DAG would re-enter the loop node.
  return recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    finishNodeExecution(
      state.execution,
      { status: 'completed' },
      {
        output: {
          text: state.lastOutput,
          structured: state.lastStructuredOutput,
          declaredOutputPaths: declaredOutputPathsFromSchema(node.output_format),
        },
        tokens: state.tokens,
        tokensUnknown: state.tokensUnknown,
        costUsd: state.costUsd,
        costPartial: !state.costKnown,
        stopReason: state.stopReason,
        numTurns: state.numTurns,
        resolvedModel: state.resolvedModel?.id,
        sessionId: state.sessionId,
        diagnostics: {
          loopIterations: i,
          ...(state.backgroundTasksIncomplete.size > 0
            ? { backgroundTasksIncomplete: [...state.backgroundTasksIncomplete] }
            : {}),
        },
      }
    )
  );
}

async function suppressLoopGate(
  run: LoopRun,
  state: LoopState,
  iteration: number,
  origin: string
): Promise<NodeExecutionResult> {
  const { ctx } = run;
  const skipped = finishNodeExecution(
    state.execution,
    { status: 'skipped', reason: 'trigger_rule', cause: { kind: 'upstream_failed', origin } },
    {
      ...loopSpend(state),
      costPartial: !state.costKnown,
      stopReason: state.stopReason,
      numTurns: state.numTurns,
      resolvedModel: state.resolvedModel?.id,
      sessionId: state.sessionId,
      diagnostics: { loopIterations: iteration },
    }
  );
  // Skipped lifecycle rows settle the invocation; the accounting fold reads spend
  // from the existing usage-only channel rather than skipped rows.
  await persistNodeEvent(ctx.deps.store, serializeDeferredNodeUsage(skipped));
  return recordNodeState({ store: ctx.deps.store, logDir: ctx.logDir }, skipped);
}

async function pauseAtLoopGate(
  run: LoopRun,
  state: LoopState,
  i: number,
  gate: { honestMessage: string; completionDetected: boolean }
): Promise<NodeExecutionResult> {
  const { ctx, node } = run;
  const { deps, platform, conversationId, workflowRun, logDir } = ctx;
  const { honestMessage, completionDetected } = gate;
  const suspended = finishNodeExecution(
    state.execution,
    { status: 'suspended', point: 'interactive_loop' },
    {
      output: { text: state.lastOutput, structured: state.lastStructuredOutput },
      tokens: state.tokens,
      tokensUnknown: state.tokensUnknown,
      costUsd: state.costUsd,
      costPartial: !state.costKnown,
      stopReason: state.stopReason,
      numTurns: state.numTurns,
      resolvedModel: state.resolvedModel?.id,
      sessionId: state.sessionId,
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
    sessionId: state.sessionId ?? null,
    ...snapshotBodySessionCursorAncestry(ctx.bodySessionCursorAncestry),
    // Signal state for finalize-on-bare-approve (#2074). The structured payload
    // rides along (#2637) so the finalize attaches it like a natural completion.
    completionSignaled: completionDetected,
    signaledOutput: completionDetected ? state.lastOutput : null,
    signaledStructuredOutput: completionDetected ? (state.lastStructuredOutput ?? null) : null,
    iterationOutput: state.lastOutput,
    // Cumulative usage consumed through this gate. A resumed loop seeds its
    // totals from these values so later gates and terminal metadata preserve
    // every pre-gate iteration; bare approval uses the same values directly.
    signaledTokens: state.tokens ?? null,
    signaledCostUsd: state.costUsd ?? null,
    // Read-once resolved template for both prompt- and command-backed loops.
    // Included command-backed loops use their load-time compiled body here, so
    // snapshotting both forms preserves resume determinism after source deletion.
    commandSnapshot: run.promptTemplate,
  };
  const deferredLoopOutput: NodeExecutionResult = {
    ...serializeNodeOutput(state.execution),
    ...(state.costUsd !== undefined ? { costUsd: state.costUsd } : {}),
    ...(state.tokens !== undefined ? { tokens: state.tokens } : {}),
    ...(state.tokensUnknown ? { tokensUnknown: true } : {}),
  };
  return runOrStagePause(
    ctx,
    async () => {
      const paused = await pauseGateRespectingExternalTransition(
        deps,
        workflowRun.id,
        approvalContext,
        { event: serializeNodeStateRecord(suspended), boundary: ctx.containerPause }
      );
      if (!paused) {
        if (state.costUsd !== undefined || state.tokens !== undefined || state.tokensUnknown) {
          await persistNodeEvent(deps.store, serializeDeferredNodeUsage(suspended));
        }
        return deferredLoopOutput;
      }
      await recordDerivedExecution({ logDir }, suspended);
      const gateMsg =
        `⏸ **Input required** (loop \`${node.id}\`, iteration ${String(i)}): ${honestMessage}\n\n` +
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
        run.stepName,
        gateMsg
      );
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'approval_requested',
          step_name: run.stepName,
          data: { message: honestMessage, iteration: i, completionSignaled: completionDetected },
        })
        .catch((err: Error) => {
          logIterationEventError(node.id, err, i);
        });

      return serializeNodeOutput(suspended);
    },
    async selected => {
      if (
        !selected &&
        (state.costUsd !== undefined || state.tokens !== undefined || state.tokensUnknown)
      ) {
        await persistNodeEvent(deps.store, serializeDeferredNodeUsage(suspended));
      }
      return deferredLoopOutput;
    }
  );
}
