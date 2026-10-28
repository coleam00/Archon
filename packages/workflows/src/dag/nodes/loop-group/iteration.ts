import { ParentStatusReadError } from '../../../parent-status-read';
import { BASE_COMPLETION_CHANNELS, type BaseCompletionChannel } from '../../../schemas/loop';
import { loopBodyAdmission } from '../../../interaction-admission';
import { resolveBashPath } from '@archon/git';
import { buildHonestGateMessage, type LoopCompletionCheck } from '../../loop-completion';
import {
  runOrStagePause,
  pauseGateRespectingExternalTransition,
  sendPauseNotice,
  snapshotBodySessionCursorAncestry,
} from '../../pause';
import { finishNodeExecution, executionMetadata } from '../../../node-execution';
import { serializeNodeStateRecord, serializeNodeOutput } from '../../../node-record-serialization';
import { recordDerivedExecution } from '../../../node-event-write';
import { spellWorkflowCommand } from '../../../deps';
import { gateOccurrence } from '../../../schemas/workflow-run';
import type { ApprovalContext, GateNode, NodeOutput, WaitNode } from '../../../schemas';
import { canSuspend, isGateNode } from '../../../schemas';
import { planGraph } from '../../../graph-plan';
import { getWorkflowEventEmitter } from '../../../event-emitter';
import { writeNodeArtifactsListing } from '../../../artifacts-index';
import {
  aggregateProviderFailure,
  rootFailures,
  detectCompletionSignal,
  stripCompletionTags,
} from '../../../executor-shared';
import { substituteWorkflowVariables } from '../../../workflow-variables';
import { safeSendMessage } from '../../../platform-messages';
import { getLog } from '../../log';
import { runLayers } from '../../run-layers';
import { sumTokenUsage } from '../../usage';
import type { RunLayersContext } from '../../run-context';
import { nodeTemplateReferences } from '../../references';
import { loopBodyScope, type LoopBodyScope } from '../../loop-scope';
import { shouldContinueStreamingForStatus } from '../../run-control';
import {
  findLoopGroupTerminalSuspendNode,
  ownsStagedGate,
  ownsTerminalWait,
  logGroupIterationEventError,
  loopGroupIterationOutput,
  type LoopGroupBodyResult,
  type LoopGroupRun,
  type LoopGroupState,
} from './loop-group-state';
import { runGroupUntilBash } from './until-bash';

/** One iteration's body run: its scoped outputs and the context it ran in. */
interface BodyRun {
  iterCtx: RunLayersContext;
  scopedNodeOutputs: Map<string, NodeOutput>;
  /** The previous iteration's body outputs, as this iteration's $LOOP_PREV.* read them. */
  prevSnapshot: Map<string, NodeOutput> | undefined;
  terminalSuspendNode: GateNode | WaitNode | undefined;
}

/**
 * Run one loop-group iteration. Returns the group's result when the iteration ends the
 * group — a stop, a body failure, a suspension, completion or an interactive gate — and
 * undefined when the group goes on to the next iteration.
 */
export async function runLoopGroupIteration(
  run: LoopGroupRun,
  state: LoopGroupState,
  i: number
): Promise<LoopGroupBodyResult | undefined> {
  const { ctx, node } = run;
  const group = node.loop_group;
  const iterationStart = Date.now();

  const stopped = await stopBeforeIteration(run, i);
  if (stopped !== undefined) return stopped;
  recordIterationStarted(run, i);

  const body = bodyIteration(run, state, i);
  await runLayers(body.iterCtx);
  addIterationUsage(run, body.iterCtx, i);

  // A body approval/cancel node may have paused or cancelled the run mid-iteration.
  // `paused` is tolerated (a sibling gate in the same iteration layer) — mirror
  // executeLoopNode's between-iteration tolerance — but a terminal/cancelled state
  // means the loop must stop now, skipping snapshot/completion handling for this
  // iteration. Re-check before proceeding.
  const postBodyStatus = await readParentStatus(run);
  // null (run row gone / deleted) is a stop condition too — treat it as 'deleted'.
  if (!shouldContinueStreamingForStatus(postBodyStatus)) {
    const effectiveStatus = postBodyStatus ?? 'deleted';
    getLog().info(
      { workflowRunId: ctx.workflowRun.id, nodeId: node.id, iteration: i, status: effectiveStatus },
      'loop_group_node.post_body_stop'
    );
    return {
      state: 'failed',
      output: state.lastOutput,
      error: `Workflow ${effectiveStatus}`,
      failureKind: 'cancelled',
      ...run.progress.usage,
      loopIterations: run.progress.lastStartedIteration,
    };
  }
  // Carry the body's final sequential session into the next iteration (unless
  // fresh_context forces a reset, handled by seeding undefined). Taken
  // before handling the terminal gate below: its pause persists this
  // cursor, and a cursor from before the paused iteration would resume without
  // that iteration's turns (#3532).
  state.lastSequentialSession = body.iterCtx.lastSequentialSession;

  const halted =
    (await failedBody(run, state, i, body)) ??
    (await suspendedBody(run, state, i, body, postBodyStatus));
  if (halted !== undefined) return halted;

  const origin = ctx.interactionAdmission?.failure();
  if (origin !== undefined && canSuspend(node)) {
    return {
      state: 'skipped',
      output: '',
      cause: { kind: 'upstream_failed', origin },
      ...run.progress.usage,
      loopIterations: i,
    };
  }

  // Carry prior-iteration snapshot forward for $LOOP_PREV.* on the next iteration.
  state.loopPrevOutputs = new Map(body.scopedNodeOutputs);
  const iterationOutput = acceptIterationOutput(run, state, body);
  const prevIterationOutput = iterationOutput.prevIterationOutput;

  const completionChecks = await checkCompletion(run, i, {
    body,
    iterationOutput: iterationOutput.raw,
    prevIterationOutput,
  });
  if (!Array.isArray(completionChecks)) return completionChecks;

  const duration = Date.now() - iterationStart;
  const completionDetected = completionChecks.some(check => check.completed);
  recordIterationCompleted(run, i, duration, completionDetected);

  // Completion: honor the completed iteration only when the AI had input to evaluate (interactive
  // first run always gates first — mirrors executeLoopNode's interactiveFirstRun),
  // UNLESS the author opted into autonomous completion via signal_completes (#2074).
  const interactiveFirstRun = group.interactive && !run.resume.isLoopResume;
  const signalCompletes = group.signal_completes === true;
  if (completionDetected && (!interactiveFirstRun || signalCompletes)) {
    return completeLoopGroup(run, state, i);
  }

  // Interactive gate — pause after an iteration that did not complete (or, when
  // interactiveFirstRun && !signalCompletes, an iteration that DID complete — the honest
  // status line + persisted completion state (#2074) let a bare approve finalize it).
  if (group.interactive && group.gate_message) {
    const honestMessage = buildHonestGateMessage(
      completionChecks,
      state.lastOutput,
      group.gate_message
    );
    return pauseAtGroupGate(run, state, i, { honestMessage, completionDetected });
  }
  return undefined;
}

async function readParentStatus({ ctx, node }: LoopGroupRun) {
  try {
    return await ctx.deps.store.getWorkflowRunStatus(ctx.workflowRun.id);
  } catch (cause) {
    throw new ParentStatusReadError(ctx.workflowRun.id, node.id, cause);
  }
}

/** Between-iteration status check (paused tolerated — mirrors executeLoopNode). */
async function stopBeforeIteration(
  run: LoopGroupRun,
  i: number
): Promise<LoopGroupBodyResult | undefined> {
  const { ctx, node } = run;
  const runStatus = await readParentStatus(run);
  if (shouldContinueStreamingForStatus(runStatus)) return undefined;
  const effectiveStatus = runStatus ?? 'deleted';
  getLog().info(
    { workflowRunId: ctx.workflowRun.id, nodeId: node.id, iteration: i, status: effectiveStatus },
    'loop_group_node.stop_detected'
  );
  await safeSendMessage(
    ctx.platform,
    ctx.conversationId,
    `Loop-group node '${node.id}' stopped at iteration ${String(i)} (${effectiveStatus})`,
    run.msgContext
  );
  return {
    state: 'failed',
    output: '',
    error: `Workflow ${effectiveStatus}`,
    failureKind: 'cancelled',
    ...run.progress.usage,
    loopIterations: run.progress.lastStartedIteration,
  };
}

function recordIterationStarted(run: LoopGroupRun, i: number): void {
  run.progress.lastStartedIteration = i;
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
      logGroupIterationEventError(node.id, err, i);
    });
}

/**
 * The body's run context for one iteration. Body layering is recomputed per iteration
 * from the (possibly $LOOP_PREV-substituted) body nodes — runLayers walks ctx.layers, so
 * the layers must reference the substituted nodes for $LOOP_PREV resolution to take
 * effect. depends_on shape is static, so the layering is stable; only the prompt text
 * changes per iteration.
 */
function bodyIteration(run: LoopGroupRun, state: LoopGroupState, i: number): BodyRun {
  const { ctx, node, bodyNodes, resume } = run;
  const group = node.loop_group;
  // This iteration's $LOOP_PREV.* outputs and $LOOP_USER_INPUT reply, which every body
  // node resolves through iterCtx.loopBodyScopes. On iteration 1 loopPrevOutputs is
  // empty → $LOOP_PREV refs resolve to ''; $LOOP_USER_INPUT is '' except on the first
  // resumed iteration of an interactive loop.
  const prevSnapshot = state.loopPrevOutputs ?? new Map<string, NodeOutput>();
  const userInputForIter =
    resume.isLoopResume && i === resume.startIteration ? resume.loopUserInput : '';
  const iterScope = loopBodyScope(bodyNodes, prevSnapshot, userInputForIter, ctx.artifactsDir);
  const iterBodyLayers = planGraph(bodyNodes).layers;

  // Fresh scoped output map per iteration. Seed it read-only with the outer DAG's
  // upstream outputs so body nodes can reference outer context via $nodeId.output if
  // needed (the body is sealed against depends_on, but prompt refs remain valid).
  const scopedNodeOutputs = new Map<string, NodeOutput>(ctx.nodeOutputs);

  const terminalSuspendNode = findLoopGroupTerminalSuspendNode(bodyNodes);
  const iterCtx: RunLayersContext = {
    providerLimitDeadline: ctx.providerLimitDeadline,
    toolAttention: ctx.toolAttention,
    containerPause: ctx.containerPause,
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
    workflowProvider: run.workflowProvider,
    // The group's own resolved provider and model become the body's defaults, the
    // pair the schema documents. `workflowModel` already carries the group's model
    // when it declared one and the enclosing workflow's otherwise, so body AI nodes
    // resolve aliases and defaults the same way top-level nodes do, and a per-node
    // `model:` in the body still wins over both.
    workflowModel: run.workflowModel,
    // The tier and preset travel WITH the model. A tier ref resolves to a provider,
    // a model and an effort as one unit; forwarding the model while leaving the
    // enclosing tier and preset in place would run the group's model, attribute it to
    // the workflow's tier, and apply the workflow preset's effort to it.
    workflowLevelOptions: { ...ctx.workflowLevelOptions, workflowTier: run.workflowTier },
    aiProfile: ctx.aiProfile,
    workflowPreset: run.workflowPreset,
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
    interactionAdmission: loopBodyAdmission(ctx.interactionAdmission),
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
    bodySessionCursors: resume.bodySessionCursors,
    bodySessionCursorAncestry: resume.bodySessionCursorAncestry,
    lastSequentialSession: group.fresh_context || i === 1 ? undefined : state.lastSequentialSession,
    warnedProviderConflicts: ctx.warnedProviderConflicts,
    totalCostUsd: undefined,
    totalTokens: undefined,
    totalTokensUnknown: false,
    stepNamePrefix: run.bodyStepNamePrefix,
    loopGroupPath: [...ctx.loopGroupPath, { groupId: node.id, iteration: i }],
    // Deliver this iteration's approval-gate free-text to body exec: nodes via env
    // (#2115, #2725). Script bodies use this as their ONLY channel (their loop scope leaves
    // the literal token alone, unsafe to splice into TS/Python source). Bash bodies get
    // it as a SECOND channel — their loop scope shell-quotes the literal
    // "$LOOP_USER_INPUT" token into the script source; this env var covers indirect reads
    // (${LOOP_USER_INPUT}, printenv, env) that splice can't reach.
    bodyLoopUserInput: userInputForIter,
    loopPrevOutputs: prevSnapshot,
    loopBodyScopes: [...ctx.loopBodyScopes, iterScope],
  };
  return { iterCtx, scopedNodeOutputs, prevSnapshot, terminalSuspendNode };
}

/** Accumulate usage across iterations (charged on the failure paths too). */
function addIterationUsage(run: LoopGroupRun, iterCtx: RunLayersContext, i: number): void {
  const { usage } = run.progress;
  if (iterCtx.totalCostUsd !== undefined) {
    usage.costUsd = (usage.costUsd ?? 0) + iterCtx.totalCostUsd;
  }
  usage.tokensUnknown ||= iterCtx.totalTokensUnknown;
  if (usage.tokensUnknown) {
    usage.tokens = undefined;
  } else if (iterCtx.totalTokens !== undefined) {
    usage.tokens = sumTokenUsage(
      [...(usage.tokens !== undefined ? [usage.tokens] : []), iterCtx.totalTokens],
      { nodeId: run.node.id, iteration: i }
    );
  }
}

/**
 * A failed body node fails the group immediately — mirrors the top-level DAG
 * (any failed node fails the run) and executeLoopNode (an iteration failure stops
 * the loop). Silently re-running the body would burn AI cost every remaining
 * iteration and bury the root cause under a generic max-iterations error.
 */
async function failedBody(
  run: LoopGroupRun,
  state: LoopGroupState,
  i: number,
  body: BodyRun
): Promise<LoopGroupBodyResult | undefined> {
  const { ctx, node } = run;
  const failedBodyOutputs = run.bodyNodes.flatMap(n => {
    const o = body.scopedNodeOutputs.get(n.id);
    return o?.state === 'failed' ? [{ id: n.id, output: o }] : [];
  });
  if (failedBodyOutputs.length === 0) return undefined;
  const failedBodyNodes = failedBodyOutputs.map(({ id, output }) => `'${id}': ${output.error}`);
  const providerFailure = aggregateProviderFailure(
    rootFailures(run.bodyNodes, body.scopedNodeOutputs).map(({ output }) => output.providerFailure),
    Date.now(),
    ctx.providerLimitDeadline
  );
  const errorMsg = `Loop-group node '${node.id}' failed at iteration ${String(i)}: ${failedBodyNodes.join('; ')}`;
  getLog().warn(
    { nodeId: node.id, iteration: i, failedCount: failedBodyNodes.length },
    'loop_group_node.body_node_failed'
  );
  await safeSendMessage(ctx.platform, ctx.conversationId, errorMsg, run.msgContext);
  return {
    state: 'failed',
    output: state.lastOutput,
    error: errorMsg,
    failureKind: 'child_failed',
    ...(providerFailure !== undefined ? { providerFailure } : {}),
    ...run.progress.usage,
    loopIterations: i,
  };
}

/** A paused run whose body stopped in this iteration leaves the group running. */
async function suspendedBody(
  run: LoopGroupRun,
  state: LoopGroupState,
  i: number,
  body: BodyRun,
  postBodyStatus: string | null
): Promise<LoopGroupBodyResult | undefined> {
  const staged =
    run.ctx.containerPause?.publish !== undefined &&
    run.ctx.claimedWorkPausePolicy !== 'finish_through_parent_pause';
  const running: LoopGroupBodyResult = {
    state: 'running',
    output: state.lastOutput,
    ...run.progress.usage,
    loopIterations: i,
  };
  if (staged) {
    const suspensionPoint = await stagedSuspensionPoint(run, i, body.terminalSuspendNode);
    return { ...running, ...(suspensionPoint !== undefined ? { suspensionPoint } : {}) };
  }
  if (postBodyStatus !== 'paused') return undefined;
  const { terminalSuspendNode, scopedNodeOutputs } = body;
  if (terminalSuspendNode) {
    const suspendOutput = scopedNodeOutputs.get(terminalSuspendNode.id);
    // Still running means the terminal gate or wait either suspended this group or was
    // deferred behind a sibling that holds the paused slot. Either way the iteration
    // stops here; only a suspension this group owns is marked as one.
    if (suspendOutput === undefined || suspendOutput.state === 'running') {
      const suspensionPoint = await ownedSuspensionPoint(
        run,
        i,
        terminalSuspendNode,
        suspendOutput
      );
      return { ...running, ...(suspensionPoint !== undefined ? { suspensionPoint } : {}) };
    }
  }
  if (run.bodyNodes.some(n => canSuspend(n) && scopedNodeOutputs.get(n.id)?.state === 'running')) {
    return running;
  }
  return undefined;
}

/** The suspension this group owns when its terminal gate or wait is the staged container pause. */
async function stagedSuspensionPoint(
  run: LoopGroupRun,
  i: number,
  terminal: GateNode | WaitNode | undefined
): Promise<'approval' | 'wait' | undefined> {
  if (terminal === undefined) return undefined;
  if (isGateNode(terminal)) return ownsStagedGate(run, i, terminal.id) ? 'approval' : undefined;
  return (await ownsTerminalWait(run, i, terminal.id)) ? 'wait' : undefined;
}

async function ownedSuspensionPoint(
  run: LoopGroupRun,
  i: number,
  terminalSuspendNode: GateNode | WaitNode,
  suspendOutput: NodeOutput | undefined
): Promise<'approval' | 'wait' | undefined> {
  if (isGateNode(terminalSuspendNode)) {
    return suspendOutput?.execution?.lifecycle.status === 'suspended' ? 'approval' : undefined;
  }
  return (await ownsTerminalWait(run, i, terminalSuspendNode.id)) ? 'wait' : undefined;
}

/**
 * Make this iteration's output the group's last output. Returns the raw output, which
 * signal detection reads, and the previous iteration's (cleaned) output, which the
 * until_bash env exposes as LOOP_PREV_OUTPUT (previous iteration, same semantics as
 * executeLoopNode; empty on the first iteration).
 */
function acceptIterationOutput(
  run: LoopGroupRun,
  state: LoopGroupState,
  body: BodyRun
): { raw: string; prevIterationOutput: string } {
  // DELIBERATELY NOT `returns:`-aware (#2470): a loop_group's per-iteration output is
  // the iteration's own result, not a caller contract — `returns:` selects a WORKFLOW's
  // result and only rebinds a child run's terminal output (see executeDagWorkflow). Leave
  // this positional scan as-is; do not "fix" the inconsistency.
  const iterationResult = loopGroupIterationOutput(run.bodyNodes, body.scopedNodeOutputs);
  const iterationOutput = iterationResult?.output ?? '';
  const prevIterationOutput = state.lastOutput;
  // Signal detection uses the raw output; the stored/returned output is stripped of
  // completion-signal tags so the marker never leaks into $groupId.output (mirrors
  // executeLoopNode's cleanOutput handling).
  state.lastOutput = stripCompletionTags(iterationOutput, run.node.loop_group.until);
  // The sink's structured payload rides along AS-IS (#2637): a JSON payload never
  // contains the completion tag, so no stripping applies to it.
  state.lastStructuredOutput =
    iterationResult !== undefined && 'structuredOutput' in iterationResult
      ? iterationResult.structuredOutput
      : undefined;
  return { raw: iterationOutput, prevIterationOutput };
}

/**
 * Completion gate: until-signal in the terminal output, and/or until_bash exit 0.
 * Short-circuit: if the until-signal already detected completion, skip the
 * until_bash subprocess (avoids unnecessary side effects and shell cost) — OR
 * semantics mean the group is already complete.
 *
 * `until` is optional (#2563): a group that declared only `until_bash` has no
 * prose path at all, so never call detectCompletionSignal with an undefined
 * signal — its regexes would be built from the empty string and match anything.
 */
async function checkCompletion(
  run: LoopGroupRun,
  i: number,
  iteration: { body: BodyRun; iterationOutput: string; prevIterationOutput: string }
): Promise<LoopCompletionCheck[] | LoopGroupBodyResult> {
  const group = run.node.loop_group;
  const completionChecks: LoopCompletionCheck[] = [];
  async function evaluateChannel(
    field: BaseCompletionChannel
  ): Promise<LoopCompletionCheck | LoopGroupBodyResult | undefined> {
    switch (field) {
      case 'until':
        if (group.until === undefined) break;
        return {
          channel: field,
          signal: group.until,
          completed: detectCompletionSignal(iteration.iterationOutput, group.until),
        };
      case 'until_bash': {
        if (group.until_bash === undefined) break;
        let completed = false;
        if (!completionChecks.some(check => check.completed)) {
          const bash = await iterationUntilBash(run, i, group.until_bash, iteration);
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
  for (const { field } of BASE_COMPLETION_CHANNELS) {
    const check = await evaluateChannel(field);
    if (check === undefined) continue;
    if ('state' in check) return check;
    completionChecks.push(check);
  }
  return completionChecks;
}

async function iterationUntilBash(
  run: LoopGroupRun,
  i: number,
  untilBash: string,
  iteration: { body: BodyRun; prevIterationOutput: string }
): Promise<boolean | LoopGroupBodyResult> {
  const { ctx, node, resume } = run;
  const { workflowRun, artifactsDir } = ctx;
  // Resolve outside the try so ARCHON_BASH_PATH validation errors bubble up
  // to the caller instead of being swallowed by the per-iteration catch.
  const groupBashPath = resolveBashPath();
  // Observed after the body ran, so the condition sees the typed artifacts this
  // iteration published. Outside the try: a materialization fault is a
  // provisioning error, not an unreachable bash binary.
  const typedArtifactsFile = await writeNodeArtifactsListing(artifactsDir, workflowRun.id);
  // Resolve this group's own cross-iteration refs against the snapshot captured
  // before its body ran. `loopPrevOutputs` now contains the CURRENT iteration, so
  // using it here would collapse `$LOOP_PREV` into `$node.output` semantics. Only
  // direct body ids belong to this scope; refs owned by an enclosing group resolve
  // through that group's scope ahead of this one, and descendant ids are not
  // present in this group's per-iteration output map.
  const ownScope: LoopBodyScope = {
    loopPrevOutputs: iteration.body.prevSnapshot,
    outputFileDir: artifactsDir,
    knownBodyIds: run.directBodyIds,
    directBodyIds: run.directBodyIds,
  };
  const substitute = (): string =>
    substituteWorkflowVariables(
      untilBash,
      workflowRun.id,
      workflowRun.user_message,
      artifactsDir,
      ctx.baseBranch,
      ctx.docsDir,
      ctx.issueContext,
      undefined,
      undefined,
      undefined,
      {
        shellSafe: true,
        stateDir: ctx.stateDir,
        typedArtifactsFile,
        references: nodeTemplateReferences(
          untilBash,
          {
            nodeOutputs: iteration.body.scopedNodeOutputs,
            loopBodyScopes: [...ctx.loopBodyScopes, ownScope],
          },
          'shell',
          {
            artifactsDir,
            requiredContext: { consumerId: node.id, field: 'loop_group.until_bash' },
          }
        ),
      }
    ).prompt;
  return runGroupUntilBash(run, i, {
    path: groupBashPath,
    script: substitute,
    loopUserInput: i === resume.startIteration ? resume.loopUserInput : '',
    loopPrevOutput: iteration.prevIterationOutput,
    typedArtifactsFile,
  });
}

function recordIterationCompleted(
  run: LoopGroupRun,
  i: number,
  duration: number,
  completionDetected: boolean
): void {
  const { ctx, node } = run;
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
      data: { iteration: i, duration, completionDetected, nodeId: node.id },
    })
    .catch((err: Error) => {
      logGroupIterationEventError(node.id, err, i);
    });
}

async function completeLoopGroup(
  run: LoopGroupRun,
  state: LoopGroupState,
  i: number
): Promise<LoopGroupBodyResult> {
  await safeSendMessage(
    run.ctx.platform,
    run.ctx.conversationId,
    `Loop-group node '${run.node.id}' completed after ${String(i)} iteration${i > 1 ? 's' : ''}`,
    run.msgContext
  );
  return {
    state: 'completed',
    output: state.lastOutput,
    ...run.progress.usage,
    loopIterations: i,
    // The final iteration's sink payload, so downstream `$group.output.field`
    // resolves from the logical value (#2637). No declaredOutputPaths: a group's
    // own output_format is ignored, so field access stays tier-2 lenient.
    ...(state.lastStructuredOutput !== undefined
      ? { structuredOutput: state.lastStructuredOutput }
      : {}),
  };
}

async function pauseAtGroupGate(
  run: LoopGroupRun,
  state: LoopGroupState,
  i: number,
  gate: { honestMessage: string; completionDetected: boolean }
): Promise<LoopGroupBodyResult> {
  const { ctx, node, resume } = run;
  const { deps, platform, conversationId, workflowRun } = ctx;
  const { honestMessage, completionDetected } = gate;
  await ctx.interactionAdmission?.beforeInteraction();
  const failure = ctx.interactionAdmission?.failure();
  if (failure !== undefined)
    return {
      state: 'skipped',
      output: '',
      cause: { kind: 'upstream_failed', origin: failure },
      ...run.progress.usage,
      loopIterations: i,
    };
  const suspended = finishNodeExecution(
    run.execution,
    { status: 'suspended', point: 'interactive_loop' },
    {
      output: { text: state.lastOutput, structured: state.lastStructuredOutput },
      ...run.progress.usage,
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
    sessionId: state.lastSequentialSession?.sessionId ?? null,
    sessionProvider: state.lastSequentialSession?.provider ?? null,
    ...(resume.bodySessionCursors !== undefined
      ? { bodySessionCursors: Object.fromEntries(resume.bodySessionCursors) }
      : {}),
    ...snapshotBodySessionCursorAncestry(resume.bodySessionCursorAncestry),
    // Signal state for finalize-on-bare-approve (#2074). The structured payload
    // rides along (#2637) so the finalize attaches it like a natural completion.
    completionSignaled: completionDetected,
    signaledOutput: completionDetected ? state.lastOutput : null,
    signaledStructuredOutput: completionDetected ? (state.lastStructuredOutput ?? null) : null,
    // NO `signaledTokens` — a loop_group gate has no consumer for it. The body's
    // own `<groupId>.<nodeId>` rows already persisted this iteration's usage before
    // the pause, so the group's bare-approve finalize deliberately writes no `tokens`.
    // Only the plain `loop` gate carries it.
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
      if (!paused)
        return {
          state: 'running',
          output: state.lastOutput,
          ...run.progress.usage,
          loopIterations: i,
        };
      await recordDerivedExecution({ logDir: ctx.logDir }, suspended);
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
          logGroupIterationEventError(node.id, err, i);
        });

      return { ...serializeNodeOutput(suspended), loopIterations: i };
    },
    () => ({ state: 'running', output: state.lastOutput, ...run.progress.usage, loopIterations: i })
  );
}
