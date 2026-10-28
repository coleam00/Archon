import { ParentStatusReadError } from '../../../parent-status-read';
import { BASE_COMPLETION_CHANNELS } from '../../../schemas/loop';
import { resolveBashPath } from '@archon/git';
import { executeWaitNode } from '../wait/wait';
import { snapshotBodySessionCursorAncestry } from '../../pause';
import { nodeInvocationKey, parseNodeInvocationKey } from '../../../node-record-reader';
import type { NodeInvocation } from '../../../schemas/node-execution';
import type {
  ApprovalContext,
  DagNode,
  LoopGateRunMetadata,
  LoopGroupNode,
  NodeOutput,
  WorkflowWaitContext,
} from '../../../schemas';
import {
  bodySessionCursorsSchema,
  bodySessionCursorAncestrySchema,
  type BodySessionCursorAncestry,
  type SessionCursor,
} from '../../../schemas';
import {
  definedOutputPaths,
  isWorkflowWaitContext,
  isApprovalContext,
  isNodeContextResume,
} from '../../../schemas';
import { writeNodeArtifactsListing } from '../../../artifacts-index';
import { substituteWorkflowVariables } from '../../../workflow-variables';
import { detectCompletionSignal, stripCompletionTags } from '../../../executor-shared';
import { safeSendMessage } from '../../../platform-messages';
import {
  ownsBodySessionCursor,
  type RunLayersContext,
  type SequentialSessionCursor,
} from '../../run-context';
import { nodeTemplateReferences } from '../../references';
import {
  findLoopGroupTerminalSuspendNode,
  ownsTerminalWait,
  loopGroupIterationOutput,
  type LoopGroupBodyResult,
  type LoopGroupProgress,
  type LoopGroupResume,
  type LoopGroupRun,
  type LoopGroupState,
} from './loop-group-state';
import { runGroupUntilBash } from './until-bash';
import { restorePreviousIteration } from './previous-iteration';

interface ResumeShape {
  loopGateMeta: ApprovalContext | undefined;
  loopOwnedWaitMeta: Extract<WorkflowWaitContext, { owner: 'loop_group' }> | undefined;
  ownerInvocationKey: string;
  restoredAncestry: BodySessionCursorAncestry | undefined;
  /** A wait recorded for this node id, whatever its owner or shape. */
  rawLoopWait: boolean;
  isLegacyInteractiveLoopResume: boolean;
  isEscalatedGateResume: boolean;
  isEscalatedWaitResume: boolean;
}

/**
 * Detect loop resume (mirrors executeLoopNode); see {@link LoopGroupResume} for the shapes.
 * Records the iteration the pause already started in `progress` before any restoration
 * that can reject the persisted pause, so that failure reports it.
 */
export function readLoopGroupResume(
  ctx: RunLayersContext,
  node: LoopGroupNode,
  bodyNodes: readonly DagNode[],
  stepName: string,
  progress: LoopGroupProgress
): LoopGroupResume {
  const { loopGateMeta, ownerInvocationKey, enclosingPauseFrame } = readPausedInvocation(
    ctx,
    node,
    stepName
  );
  progress.lastStartedIteration = enclosingPauseFrame?.iteration ?? 0;
  const shape = detectResumeShape(ctx, node, loopGateMeta, ownerInvocationKey);
  const { loopOwnedWaitMeta, isLegacyInteractiveLoopResume, isEscalatedWaitResume } = shape;
  const isLoopResume =
    isLegacyInteractiveLoopResume || shape.isEscalatedGateResume || isEscalatedWaitResume;
  const resumeIteration = loopGateMeta?.iteration ?? loopOwnedWaitMeta?.iteration ?? 0;
  if (isLoopResume) progress.lastStartedIteration = resumeIteration;
  const bodySessionCursors = restoreBodySessionCursors(node, bodyNodes, {
    ...shape,
    isLoopResume,
    enclosingPauseFrame,
  });
  const startIteration = isLoopResume
    ? resumeIteration + 1
    : shape.restoredAncestry !== undefined
      ? (enclosingPauseFrame?.iteration ?? 1)
      : 1;
  const loopGateRunMeta = (ctx.workflowRun.metadata ?? {}) as LoopGateRunMetadata;
  const feedbackGiven = loopGateRunMeta.loop_feedback_given === true;
  // max_iterations bounds autonomous work. An explicit answer authorizes one fresh iteration
  // even after that bound: resuming an attention wait (which did no work while paused), or
  // feedback on this group's interactive gate. A bare approve on that gate does not.
  const answered =
    (isEscalatedWaitResume && loopOwnedWaitMeta?.kind === 'attention') ||
    (isLegacyInteractiveLoopResume && feedbackGiven);
  const maxIterations = node.loop_group.max_iterations;
  return {
    loopGateMeta,
    loopOwnedWaitMeta,
    isLegacyInteractiveLoopResume,
    isEscalatedGateResume: shape.isEscalatedGateResume,
    isEscalatedWaitResume,
    isLoopResume,
    bodySessionCursors,
    bodySessionCursorAncestry: withOwnCursors(ctx, shape.ownerInvocationKey, bodySessionCursors),
    resumeIteration,
    startIteration,
    feedbackGiven,
    iterationLimit: answered ? Math.max(maxIterations, startIteration) : maxIterations,
    loopUserInput: isLegacyInteractiveLoopResume ? (loopGateRunMeta.loop_user_input ?? '') : '',
  };
}

/** Every enclosing invocation needs a frame, even when it owns no sessions. */
function withOwnCursors(
  ctx: RunLayersContext,
  ownerInvocationKey: string,
  bodySessionCursors: Map<string, SessionCursor> | undefined
): Map<string, Map<string, SessionCursor>> {
  const bodySessionCursorAncestry = new Map(ctx.bodySessionCursorAncestry);
  bodySessionCursorAncestry.set(ownerInvocationKey, bodySessionCursors ?? new Map());
  return bodySessionCursorAncestry;
}

function detectResumeShape(
  ctx: RunLayersContext,
  node: LoopGroupNode,
  loopGateMeta: ApprovalContext | undefined,
  ownerInvocationKey: string
): ResumeShape {
  const rawWait = ctx.workflowRun.metadata?.wait;
  const loopWaitMeta = isWorkflowWaitContext(rawWait) ? rawWait : undefined;
  const loopOwnedWaitMeta = loopWaitMeta?.owner === 'loop_group' ? loopWaitMeta : undefined;
  const rawAncestry =
    loopGateMeta?.bodySessionCursorAncestry ?? loopOwnedWaitMeta?.bodySessionCursorAncestry;
  const restoredAncestry =
    rawAncestry === undefined ? undefined : bodySessionCursorAncestrySchema.parse(rawAncestry);
  const matchesOwnerInvocation =
    restoredAncestry === undefined || Object.hasOwn(restoredAncestry, ownerInvocationKey);
  return {
    loopGateMeta,
    loopOwnedWaitMeta,
    ownerInvocationKey,
    restoredAncestry,
    rawLoopWait:
      typeof rawWait === 'object' &&
      rawWait !== null &&
      'nodeId' in rawWait &&
      rawWait.nodeId === node.id,
    isLegacyInteractiveLoopResume:
      matchesOwnerInvocation &&
      loopGateMeta?.type === 'interactive_loop' &&
      loopGateMeta.nodeId === node.id,
    isEscalatedGateResume:
      matchesOwnerInvocation &&
      loopGateMeta?.type === 'approval' &&
      loopGateMeta.nodeId === node.id &&
      loopGateMeta.bodyGateId !== undefined,
    isEscalatedWaitResume: matchesOwnerInvocation && loopOwnedWaitMeta?.nodeId === node.id,
  };
}

/** This invocation's identity, and the persisted gate and the gate or wait frame for it, if any. */
function readPausedInvocation(
  ctx: RunLayersContext,
  node: LoopGroupNode,
  stepName: string
): {
  loopGateMeta: ApprovalContext | undefined;
  ownerInvocationKey: string;
  enclosingPauseFrame: { groupId: string; iteration: number } | undefined;
} {
  const rawApproval = ctx.workflowRun.metadata?.approval;
  const loopGateMeta = isApprovalContext(rawApproval) ? rawApproval : undefined;
  const ownerInvocationKey = nodeInvocationKey(stepName, ctx.loopGroupPath);
  return {
    loopGateMeta,
    ownerInvocationKey,
    enclosingPauseFrame: enclosingPauseFrameOf(
      ctx,
      node,
      stepName,
      loopGateMeta?.execution?.invocation.loopPath ??
        waitPauseLoopPath(ctx.workflowRun.metadata?.wait),
      ownerInvocationKey
    ),
  };
}

/**
 * The loop path of a loop-owned wait, from its persisted ancestry. {@link withOwnCursors}
 * adds one key per enclosing group invocation, so the key with the longest loop path is the
 * owner group's, and its loop path is the frames that enclose the owner. Undefined for a wait
 * without ancestry: nothing else persisted names the iterations it paused in.
 */
function waitPauseLoopPath(rawWait: unknown): NodeInvocation['loopPath'] | undefined {
  if (!isWorkflowWaitContext(rawWait) || rawWait.owner !== 'loop_group') return undefined;
  if (rawWait.bodySessionCursorAncestry === undefined) return undefined;
  let ownerLoopPath: NodeInvocation['loopPath'] = [];
  for (const key of Object.keys(rawWait.bodySessionCursorAncestry)) {
    const { loopPath } = parseNodeInvocationKey(key);
    if (loopPath.length > ownerLoopPath.length) ownerLoopPath = loopPath;
  }
  return [...ownerLoopPath, { groupId: rawWait.nodeId, iteration: rawWait.iteration }];
}

/** The paused gate's or wait's loop-path frame for THIS group invocation, when it paused inside it. */
function enclosingPauseFrameOf(
  ctx: RunLayersContext,
  node: LoopGroupNode,
  stepName: string,
  pauseLoopPath: NodeInvocation['loopPath'] | undefined,
  ownerInvocationKey: string
): { groupId: string; iteration: number } | undefined {
  const pauseFrame = pauseLoopPath?.[ctx.loopGroupPath.length];
  return pauseFrame?.groupId === node.id &&
    nodeInvocationKey(stepName, pauseLoopPath?.slice(0, ctx.loopGroupPath.length) ?? []) ===
      ownerInvocationKey
    ? pauseFrame
    : undefined;
}

/**
 * Restore the owner sessions of body nodes that resume an enclosing source, from the
 * pause this run resumes or an enclosing group's pause frame. Undefined when no body node
 * resumes a session context; a group whose consumers all resume same-body sources still
 * returns an (empty) map so a nested pause resumes inside the paused iteration.
 */
function restoreBodySessionCursors(
  node: LoopGroupNode,
  bodyNodes: readonly DagNode[],
  shape: ResumeShape & {
    isLoopResume: boolean;
    enclosingPauseFrame: { iteration: number } | undefined;
  }
): Map<string, SessionCursor> | undefined {
  if (!bodyNodes.some(n => isNodeContextResume(n.context))) return undefined;
  const bodyNodeIds = new Set(bodyNodes.map(n => n.id));
  const ownerIds = new Set(
    bodyNodes.filter(n => ownsBodySessionCursor(n, bodyNodeIds)).map(n => n.id)
  );
  const bodySessionCursors = new Map<string, SessionCursor>();
  if (shape.rawLoopWait && !shape.isEscalatedWaitResume) {
    throw new Error(
      `Loop group '${node.id}' cannot restore named owner sessions: invalid loop wait state.`
    );
  }
  const restoredOwnerCursors = shape.restoredAncestry?.[shape.ownerInvocationKey];
  if (
    !shape.isLoopResume &&
    restoredOwnerCursors === undefined &&
    shape.enclosingPauseFrame === undefined
  ) {
    return bodySessionCursors;
  }
  const parsed = bodySessionCursorsSchema.safeParse(
    restoredOwnerCursors ?? pausedBodySessionCursors(shape)
  );
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
  return bodySessionCursors;
}

/** The cursors the resumed pause itself recorded, before ancestry snapshots existed. */
function pausedBodySessionCursors(shape: ResumeShape & { isLoopResume: boolean }): unknown {
  if (!shape.isLoopResume || shape.restoredAncestry !== undefined) return undefined;
  return shape.isEscalatedWaitResume
    ? shape.loopOwnedWaitMeta?.bodySessionCursors
    : shape.loopGateMeta?.bodySessionCursors;
}

/**
 * Finalize-on-approve (#2074): mirrors executeLoopNode — a completion-bearing gate
 * resumed WITHOUT feedback completes the group from the persisted output instead
 * of re-running the body. Undefined when the resume is not one.
 */
export async function finalizeGroupOnBareApprove(
  run: LoopGroupRun
): Promise<LoopGroupBodyResult | undefined> {
  const { ctx, node, resume } = run;
  const gate = resume.loopGateMeta;
  if (!resume.isLoopResume || gate?.completionSignaled !== true || resume.feedbackGiven) {
    return undefined;
  }
  const finalizeOutput = gate.signaledOutput ?? '';
  // The signaled iteration's structured payload (#2637): attaching it keeps this
  // route's `$group.output.field` tier IDENTICAL to natural completion (tier-2
  // lenient) — without it the same absent optional field would throw here and
  // resolve to '' there. null/absent (pre-#2637 gates) → text-only, as before.
  const finalizeStructured = gate.signaledStructuredOutput ?? null;
  await safeSendMessage(
    ctx.platform,
    ctx.conversationId,
    `Loop-group node '${node.id}' accepted after a completion condition was met (no re-run)`,
    { workflowId: ctx.workflowRun.id, nodeName: node.id }
  );
  return {
    state: 'completed',
    output: finalizeOutput,
    ...(finalizeStructured !== null ? { structuredOutput: finalizeStructured } : {}),
  };
}

/**
 * Resume the body's terminal wait this group paused on. Returns the group's result while
 * the run is paused again; otherwise records the wait's output where the restored
 * iteration's body outputs are read from, and returns undefined.
 */
export async function resumeTerminalWait(
  run: LoopGroupRun
): Promise<LoopGroupBodyResult | undefined> {
  const { ctx, node, bodyStepNamePrefix, resume } = run;
  const terminalNode = findLoopGroupTerminalSuspendNode(run.bodyNodes);
  if (terminalNode?.kind !== 'wait') {
    throw new Error(`Loop group '${node.id}' resumed with wait state but has no terminal wait`);
  }
  const { resumeIteration, loopOwnedWaitMeta, bodySessionCursors } = resume;
  const waitOutput = await executeWaitNode(
    {
      ...ctx,
      nodeOutputs: new Map([...ctx.nodeOutputs, ...(restoreLoopPrevOutputs(run) ?? [])]),
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
      ...snapshotBodySessionCursorAncestry(resume.bodySessionCursorAncestry),
    }
  );
  let status;
  try {
    status = await ctx.deps.store.getWorkflowRunStatus(ctx.workflowRun.id);
  } catch (cause) {
    throw new ParentStatusReadError(ctx.workflowRun.id, node.id, cause);
  }
  if (ctx.containerPause?.publish !== undefined || status === 'paused') {
    return {
      state: 'running',
      output: '',
      loopIterations: resumeIteration,
      ...((await ownsTerminalWait(run, resumeIteration, terminalNode.id))
        ? { suspensionPoint: 'wait' as const }
        : {}),
    };
  }
  ctx.nodeOutputs.set(bodyStepNamePrefix + terminalNode.id, waitOutput);
  return undefined;
}

/**
 * Restore the body-output snapshot $LOOP_PREV.* reads, for the resumed iteration
 * (#2748). The pause boundary discards the group's local state, but the last
 * iteration's direct body-node outputs already survive as persisted
 * `<groupId>.<bodyId>` node_completed rows — the outer `nodeOutputs` was ALREADY
 * pre-populated from them (the run's resume pre-population in restoreRunState, itself
 * sourced from getDagResumeSnapshot's #2726/#2732 bounded-rows + spill/rehydrate
 * read), keyed by that full step name. Re-key to the bare body id so
 * the loop scope finds them exactly as it would mid-loop.
 */
export function restoreLoopPrevOutputs(run: LoopGroupRun): Map<string, NodeOutput> | undefined {
  const { ctx, bodyNodes, bodyStepNamePrefix } = run;
  const restoredLoopPrevOutputs = new Map<string, NodeOutput>();
  const bodyNodesById = new Map(bodyNodes.map(n => [n.id, n]));
  for (const id of run.directBodyIds) {
    const prior = ctx.nodeOutputs.get(bodyStepNamePrefix + id);
    if (!prior) continue;
    // Same rule as restoreRunState's resume pre-population: the body node's OWN current
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
  return restoredLoopPrevOutputs.size > 0 ? restoredLoopPrevOutputs : undefined;
}

/**
 * #2707 step 3: an escalated gate-terminated-body resume might already be
 * "done" — the human's answer, just reconstructed (the SAME restoration
 * #2748 built for $LOOP_PREV, now also finding the gate's own resolution
 * thanks to the namespaced write-path fix), may satisfy the group's own
 * until_bash. The legacy interactive_loop resume always advances blindly to
 * iteration+1; that would be WRONG here — it would silently start a whole new
 * iteration (re-running the body's pre-gate work) while ignoring an answer
 * that already meant "stop". Re-run the same completion check the normal
 * per-iteration path runs, fed from the reconstructed data instead of a
 * fresh runLayers call — decision (b) settled that resume re-enters at the
 * iteration boundary, so the pre-gate body nodes' already-produced outputs are
 * safe to reuse as-is; only the gate's own answer needed reconstructing.
 *
 * Not complete returns undefined: startIteration is already iteration+1, so the
 * iterations proceed into a genuinely fresh one, exactly as for any other resume.
 */
export async function completeEscalatedResume(
  run: LoopGroupRun,
  currentBodyOutputs: Map<string, NodeOutput> | undefined
): Promise<LoopGroupBodyResult | undefined> {
  const { resume, bodyNodes } = run;
  if (!(resume.isEscalatedGateResume || resume.isEscalatedWaitResume)) return undefined;
  if (currentBodyOutputs === undefined) return undefined;
  const terminalNode = findLoopGroupTerminalSuspendNode(bodyNodes);
  if (terminalNode === undefined || !currentBodyOutputs.has(terminalNode.id)) return undefined;
  const resumedResult = loopGroupIterationOutput(bodyNodes, currentBodyOutputs);
  const rawIterationOutput = resumedResult?.output ?? '';
  const completed = await resumedCompletion(run, currentBodyOutputs, rawIterationOutput);
  if (typeof completed !== 'boolean') return completed;
  if (!completed) return undefined;
  return completeResumedIteration(run, resumedResult, rawIterationOutput);
}

async function resumedCompletion(
  run: LoopGroupRun,
  currentBodyOutputs: Map<string, NodeOutput>,
  rawIterationOutput: string
): Promise<boolean | LoopGroupBodyResult> {
  const group = run.node.loop_group;
  for (const { field } of BASE_COMPLETION_CHANNELS) {
    switch (field) {
      case 'until':
        if (group.until !== undefined && detectCompletionSignal(rawIterationOutput, group.until)) {
          return true;
        }
        break;
      case 'until_bash': {
        if (group.until_bash === undefined) break;
        const previousBodyOutputs = await restorePreviousIteration(run);
        return resumedUntilBash(run, group.until_bash, currentBodyOutputs, previousBodyOutputs);
      }
      default: {
        const unhandled: never = field;
        return unhandled;
      }
    }
  }
  return false;
}

async function completeResumedIteration(
  run: LoopGroupRun,
  resumedResult: NodeOutput | undefined,
  rawIterationOutput: string
): Promise<LoopGroupBodyResult> {
  const resumedIteration = run.resume.resumeIteration;
  const resumedOutput = stripCompletionTags(rawIterationOutput, run.node.loop_group.until);
  const resumedStructuredOutput =
    resumedResult !== undefined && 'structuredOutput' in resumedResult
      ? resumedResult.structuredOutput
      : undefined;
  await safeSendMessage(
    run.ctx.platform,
    run.ctx.conversationId,
    `Loop-group node '${run.node.id}' completed after ${String(resumedIteration)} iteration${resumedIteration > 1 ? 's' : ''}`,
    run.msgContext
  );
  return {
    state: 'completed',
    output: resumedOutput,
    loopIterations: resumedIteration,
    ...(resumedStructuredOutput !== undefined ? { structuredOutput: resumedStructuredOutput } : {}),
  };
}

async function resumedUntilBash(
  run: LoopGroupRun,
  untilBash: string,
  currentBodyOutputs: Map<string, NodeOutput>,
  previousBodyOutputs: Map<string, NodeOutput>
): Promise<boolean | LoopGroupBodyResult> {
  const { ctx, node } = run;
  const { workflowRun, artifactsDir } = ctx;
  // Fresh observation for this resumed iteration's condition.
  const typedArtifactsFile = await writeNodeArtifactsListing(artifactsDir, workflowRun.id);
  const resumedScope = new Map([...ctx.nodeOutputs, ...currentBodyOutputs]);
  const { prompt: resumedSubstitutedBash } = substituteWorkflowVariables(
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
          nodeOutputs: resumedScope,
          loopBodyScopes: [
            ...ctx.loopBodyScopes,
            {
              loopPrevOutputs: previousBodyOutputs,
              outputFileDir: artifactsDir,
              knownBodyIds: run.directBodyIds,
              directBodyIds: run.directBodyIds,
            },
          ],
        },
        'shell',
        {
          artifactsDir,
          requiredContext: { consumerId: node.id, field: 'loop_group.until_bash' },
        }
      ),
    }
  );
  return runGroupUntilBash(run, run.resume.resumeIteration, {
    path: resolveBashPath(),
    script: () => resumedSubstitutedBash,
    loopUserInput: '',
    loopPrevOutput: stripCompletionTags(
      loopGroupIterationOutput(run.bodyNodes, previousBodyOutputs)?.output ?? '',
      node.loop_group.until
    ),
    typedArtifactsFile,
  });
}

/**
 * The state the first iteration starts from. A resumed group continues from the
 * iteration it paused in; that iteration's restored body outputs give until_bash its
 * LOOP_PREV_OUTPUT.
 */
export function initialLoopGroupState(
  run: LoopGroupRun,
  loopPrevOutputs: Map<string, NodeOutput> | undefined
): LoopGroupState {
  const { resume, bodyNodes } = run;
  const group = run.node.loop_group;
  return {
    loopPrevOutputs,
    lastOutput:
      loopPrevOutputs === undefined
        ? ''
        : stripCompletionTags(
            loopGroupIterationOutput(bodyNodes, loopPrevOutputs)?.output ?? '',
            group.until
          ),
    lastStructuredOutput: undefined,
    lastSequentialSession: resumedSequentialSession(resume),
  };
}

/**
 * On interactive resume, restore the cursor persisted at pause time so
 * fresh_context: false continues the pre-pause conversation (mirrors executeLoopNode).
 * The provider tag must be restored WITH the session id (#1992) — metadata from a
 * pre-tag pause lacks it, and restoring an untagged cursor could thread the session
 * into a different provider on resume, so those legacy pauses restore fresh instead.
 */
function resumedSequentialSession(resume: LoopGroupResume): SequentialSessionCursor | undefined {
  const { loopGateMeta, loopOwnedWaitMeta } = resume;
  const resumedLoopSessionId = loopGateMeta?.sessionId ?? loopOwnedWaitMeta?.sessionId;
  const resumedLoopSessionProvider =
    loopGateMeta?.sessionProvider ?? loopOwnedWaitMeta?.sessionProvider;
  return resume.isLoopResume &&
    typeof resumedLoopSessionId === 'string' &&
    typeof resumedLoopSessionProvider === 'string'
    ? { sessionId: resumedLoopSessionId, provider: resumedLoopSessionProvider }
    : undefined;
}
