import { executeWaitNode } from '../wait/wait';
import { buildHonestGateMessage, type LoopCompletionCheck } from '../../loop-completion';
import {
  pauseGateRespectingExternalTransition,
  sendPauseNotice,
  snapshotBodySessionCursorAncestry,
} from '../../pause';
import { hostSpawnFailure, type RawSubprocessRejection } from '../../../subprocess';
import { nodeInvocationKey } from '../../../node-record-reader';
import { finishNodeExecution, executionMetadata } from '../../../node-execution';
import {
  serializeNodeStateRecord,
  serializeNodeOutput,
  type NodeExecutionResult,
} from '../../../node-record-serialization';
import { type NodeExecutionRecord } from '../../../schemas/node-execution';
import {
  NodeEventWriteError,
  recordDerivedExecution,
  recordNodeState,
} from '../../../node-event-write';
import { resolveBashPath } from '@archon/git';
import { spellWorkflowCommand } from '../../../deps';
import { gateOccurrence } from '../../../schemas/workflow-run';
import type {
  DagNode,
  GateNode,
  WaitNode,
  LoopGroupNode,
  NodeOutput,
  LoopGateRunMetadata,
  ApprovalContext,
} from '../../../schemas';
import {
  bodySessionCursorsSchema,
  bodySessionCursorAncestrySchema,
  type SessionCursor,
} from '../../../schemas';
import {
  definedOutputPaths,
  loopGroupOutputNodes,
  loopGroupSoleTerminalSink,
  isGateNode,
  isWorkflowWaitContext,
  isApprovalContext,
  isNodeContextResume,
} from '../../../schemas';
import { planGraph, resolvedBodyNodes } from '../../../graph-plan';
import { getWorkflowEventEmitter } from '../../../event-emitter';
import { TerminalStatusWriteError } from '../../../terminal-status-write';
import { writeNodeArtifactsListing } from '../../../artifacts-index';
import {
  currentAdoptedRunDir,
  aggregateProviderFailure,
  substituteWorkflowVariables,
  detectCompletionSignal,
  describeUnmetCompletion,
  stripCompletionTags,
  safeSendMessage,
} from '../../../executor-shared';
import { type ModelAliasPreset, type TierName } from '../../../model-validation';
import { getLog } from '../../log';
import { runLayers } from '../../run-layers';
import { sumTokenUsage } from '../../usage';
import { RunSourceUnreadableError } from '../../node-source';
import {
  beginExecution,
  type RunLayersContext,
  type SequentialSessionCursor,
} from '../../run-context';
import {
  nodeTemplateReferences,
  buildNodeShellEnvironment,
  loopBodyScope,
  type LoopBodyScope,
} from '../../references';
import { shouldContinueStreamingForStatus, runSubprocessUntilRunStops } from '../../run-control';

/**
 * Only a sole terminal gate or wait can resume through its enclosing group.
 * The loader rejects other placements, which have no unambiguous owner.
 */
function findLoopGroupTerminalSuspendNode(
  bodyNodes: readonly DagNode[]
): GateNode | WaitNode | undefined {
  const sink = loopGroupSoleTerminalSink(bodyNodes);
  return sink !== undefined && (isGateNode(sink) || sink.kind === 'wait') ? sink : undefined;
}

/** An iteration's output: the first completed, non-empty one among its output nodes. */
function loopGroupIterationOutput(
  bodyNodes: readonly DagNode[],
  outputs: ReadonlyMap<string, NodeOutput>
): NodeOutput | undefined {
  return loopGroupOutputNodes(bodyNodes)
    .map(n => outputs.get(n.id))
    .find(o => o?.state === 'completed' && o.output.trim().length > 0);
}

/**
 * Execute a loop-group node — runs a multi-node sub-DAG body repeatedly until a
 * completion condition (`until` signal in the iteration's output, and/or
 * `until_bash` exit code) or `max_iterations`.
 *
 * Mirrors {@link executeLoopNode} at subgraph granularity: each iteration runs the body's
 * topological layers via {@link runLayers} against a fresh scoped `nodeOutputs` map. The
 * body is a sealed sub-DAG. Every persisted body event — both runLayers' own control
 * events (skip/trigger_rule/when) AND the node executors' lifecycle events
 * (node_started/node_completed/node_failed, and tool/task/hook activity) — is namespaced
 * `{groupId}.{nodeId}` via `stepNamePrefix`, composing across nested groups; body node
 * lifecycle rows also carry the current `iteration` in their `data` (#2090). The in-process
 * emitter payloads stay raw (unprefixed nodeId) so live SSE/CLI consumers are unaffected.
 * `$LOOP_PREV.<id>.output` refs in body prompts resolve against a snapshot of the
 * *previous* iteration's body outputs (empty on iteration 1).
 *
 * `$groupId.output` (visible to the outer DAG) = the final iteration's output, chosen by
 * {@link loopGroupIterationOutput}.
 *
 * Key behaviors:
 * - Returns NodeExecutionResult (not void) — the outer DAG executor owns run lifecycle
 * - Loop is encapsulated inside this one node; the outer DAG stays acyclic
 * - Usage (cost/tokens) is summed across iterations and returned on the final result,
 *   so the outer `runLayers` aggregates the group as one node's worth of usage
 */
export async function executeLoopGroupNode(
  ctx: RunLayersContext,
  node: LoopGroupNode,
  workflowProvider: string | undefined,
  workflowModel: string | undefined,
  workflowTier: TierName | undefined,
  workflowPreset: ModelAliasPreset | undefined
): Promise<NodeExecutionResult> {
  const execution = beginExecution(ctx, node);
  await recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    {
      ...execution,
      lifecycle: { status: 'started' },
    }
  );
  const usage: Pick<NodeExecutionResult, 'costUsd' | 'tokens' | 'tokensUnknown'> = {};
  let result: LoopGroupBodyResult;
  try {
    result = await executeLoopGroupBody(
      ctx,
      node,
      execution,
      usage,
      workflowProvider,
      workflowModel,
      workflowTier,
      workflowPreset
    );
  } catch (error) {
    // Durable-write rejection and an unreadable source belong to run recovery, not a
    // failed node outcome.
    if (
      error instanceof TerminalStatusWriteError ||
      error instanceof NodeEventWriteError ||
      error instanceof RunSourceUnreadableError
    )
      throw error;
    const err = error instanceof Error ? error : new Error(String(error));
    getLog().error({ err, nodeId: node.id }, 'loop_group_node.execution_failed');
    result = {
      state: 'failed',
      output: '',
      error: err.message,
      failureKind: 'unknown',
      ...usage,
    };
    await safeSendMessage(
      ctx.platform,
      ctx.conversationId,
      `Loop-group node '${node.id}' failed: ${err.message}`,
      { workflowId: ctx.workflowRun.id, nodeName: node.id }
    );
  }
  if (result.execution?.lifecycle.status === 'suspended') return result;
  let lifecycle: NodeExecutionRecord['lifecycle'];
  if (result.state === 'failed') {
    lifecycle = {
      status: 'failed',
      error: result.error,
      ...(result.failureKind !== undefined ? { failureKind: result.failureKind } : {}),
      ...(result.providerFailure !== undefined ? { providerFailure: result.providerFailure } : {}),
    };
  } else if (result.state === 'running') {
    const suspensionPoint = result.suspensionPoint;
    // A deferred body gate or terminal wait leaves the group running; keep the spend its
    // iterations already made.
    if (suspensionPoint === undefined)
      return {
        ...serializeNodeOutput(execution),
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
        ...(result.tokensUnknown ? { tokensUnknown: true } : {}),
      };
    lifecycle = { status: 'suspended', point: suspensionPoint };
  } else {
    lifecycle = { status: 'completed' };
  }
  return recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    finishNodeExecution(execution, lifecycle, {
      output: {
        text: result.output,
        ...('structuredOutput' in result ? { structured: result.structuredOutput } : {}),
      },
      costUsd: result.costUsd,
      tokens: result.tokens,
      tokensUnknown: result.tokensUnknown,
      diagnostics: { loopIterations: result.loopIterations },
    })
  );
}

type LoopGroupBodyResult = NodeExecutionResult & {
  suspensionPoint?: 'approval' | 'wait';
};

async function executeLoopGroupBody(
  ctx: RunLayersContext,
  node: LoopGroupNode,
  execution: NodeExecutionRecord,
  usage: Pick<NodeExecutionResult, 'costUsd' | 'tokens' | 'tokensUnknown'>,
  workflowProvider: string | undefined,
  workflowModel: string | undefined,
  workflowTier: TierName | undefined,
  workflowPreset: ModelAliasPreset | undefined
): Promise<LoopGroupBodyResult> {
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
    nodeOutputs: outerNodeOutputs,
    config,
    issueContext,
    execContext,
  } = ctx;
  const group = node.loop_group;
  const bodyNodes = resolvedBodyNodes(group);
  const msgContext = { workflowId: workflowRun.id, nodeName: node.id };
  // This group's OWN persisted step_name — namespaced by any enclosing group so nested
  // loop_groups compose (e.g. `outer.inner`); '' → node.id at the top level (#2090).
  const stepName = ctx.stepNamePrefix + node.id;

  // Body layering is recomputed per iteration from the (possibly $LOOP_PREV-substituted)
  // body nodes — runLayers walks ctx.layers, so the layers must reference the substituted
  // nodes for $LOOP_PREV resolution to take effect. depends_on shape is static, so the
  // layering is stable; only the prompt text changes per iteration.
  // Body nodes are namespaced under THIS group's (already-namespaced) step name so the
  // prefix composes across nested loop_groups: `<enclosing>.<groupId>.<bodyNodeId>`.
  const bodyStepNamePrefix = `${stepName}.`;

  // THIS group's immediate body ids: the resume snapshot is keyed by them, and until_bash
  // resolves `$LOOP_PREV` against them (#2142).
  const directBodyIds = new Set(bodyNodes.map(n => n.id));

  // Detect loop resume (mirrors executeLoopNode). Two shapes recognized:
  //  - the ORIGINAL interactive_loop gate (group.interactive + gate_message).
  //  - a body terminal gate paused under THIS group, with bodyGateId naming
  //    the leaf gate. `$LOOP_USER_INPUT`
  //    does not apply to this shape — the human's text flows via the ordinary
  //    $LOOP_PREV.<gateId>.output.text channel instead, like any other body
  //    node's output — so `loopUserInput` below stays scoped to the legacy shape.
  const rawApproval = workflowRun.metadata?.approval;
  const loopGateMeta = isApprovalContext(rawApproval) ? rawApproval : undefined;
  const rawWait = workflowRun.metadata?.wait;
  const loopWaitMeta = isWorkflowWaitContext(rawWait) ? rawWait : undefined;
  const loopOwnedWaitMeta = loopWaitMeta?.owner === 'loop_group' ? loopWaitMeta : undefined;
  const ownerInvocationKey = nodeInvocationKey(stepName, ctx.loopGroupPath);
  const rawAncestry =
    loopGateMeta?.bodySessionCursorAncestry ?? loopOwnedWaitMeta?.bodySessionCursorAncestry;
  const restoredAncestry =
    rawAncestry === undefined ? undefined : bodySessionCursorAncestrySchema.parse(rawAncestry);
  const matchesOwnerInvocation =
    restoredAncestry === undefined || Object.hasOwn(restoredAncestry, ownerInvocationKey);
  const isLegacyInteractiveLoopResume =
    matchesOwnerInvocation &&
    loopGateMeta?.type === 'interactive_loop' &&
    loopGateMeta.nodeId === node.id;
  const isEscalatedGateResume =
    matchesOwnerInvocation &&
    loopGateMeta?.type === 'approval' &&
    loopGateMeta.nodeId === node.id &&
    loopGateMeta.bodyGateId !== undefined;
  const isEscalatedWaitResume = matchesOwnerInvocation && loopOwnedWaitMeta?.nodeId === node.id;
  const isLoopResume =
    isLegacyInteractiveLoopResume || isEscalatedGateResume || isEscalatedWaitResume;
  const ownerIds = new Set(bodyNodes.filter(n => isNodeContextResume(n.context)).map(n => n.id));
  const bodySessionCursors = ownerIds.size === 0 ? undefined : new Map<string, SessionCursor>();
  const rawLoopWait =
    typeof rawWait === 'object' &&
    rawWait !== null &&
    'nodeId' in rawWait &&
    rawWait.nodeId === node.id;
  if (bodySessionCursors !== undefined && rawLoopWait && !isEscalatedWaitResume) {
    throw new Error(
      `Loop group '${node.id}' cannot restore named owner sessions: invalid loop wait state.`
    );
  }
  const pauseLoopPath = loopGateMeta?.execution?.invocation.loopPath;
  const pauseFrame = pauseLoopPath?.[ctx.loopGroupPath.length];
  const enclosingPauseFrame =
    pauseFrame?.groupId === node.id &&
    nodeInvocationKey(stepName, pauseLoopPath?.slice(0, ctx.loopGroupPath.length) ?? []) ===
      ownerInvocationKey
      ? pauseFrame
      : undefined;
  const restoredOwnerCursors = restoredAncestry?.[ownerInvocationKey];
  if (
    bodySessionCursors !== undefined &&
    (isLoopResume || restoredOwnerCursors !== undefined || enclosingPauseFrame !== undefined)
  ) {
    const rawCursors =
      restoredOwnerCursors ??
      (isLoopResume && restoredAncestry === undefined
        ? isEscalatedWaitResume
          ? loopOwnedWaitMeta?.bodySessionCursors
          : loopGateMeta?.bodySessionCursors
        : undefined);
    const parsed = bodySessionCursorsSchema.safeParse(rawCursors);
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
  }
  const bodySessionCursorAncestry = new Map(ctx.bodySessionCursorAncestry);
  if (bodySessionCursors !== undefined || bodySessionCursorAncestry.size > 0) {
    bodySessionCursorAncestry.set(ownerInvocationKey, bodySessionCursors ?? new Map());
  }
  const resumeIteration = loopGateMeta?.iteration ?? loopOwnedWaitMeta?.iteration ?? 0;
  const startIteration = isLoopResume
    ? resumeIteration + 1
    : restoredAncestry !== undefined
      ? (enclosingPauseFrame?.iteration ?? 1)
      : 1;
  const loopGateRunMeta = (workflowRun.metadata ?? {}) as LoopGateRunMetadata;
  const feedbackGiven = loopGateRunMeta.loop_feedback_given === true;
  // max_iterations bounds autonomous work. An explicit answer authorizes one fresh iteration
  // even after that bound: resuming an attention wait (which did no work while paused), or
  // feedback on this group's interactive gate. A bare approve on that gate does not.
  const iterationLimit =
    (isEscalatedWaitResume && loopOwnedWaitMeta?.kind === 'attention') ||
    (isLegacyInteractiveLoopResume && feedbackGiven)
      ? Math.max(group.max_iterations, startIteration)
      : group.max_iterations;
  const loopUserInput = isLegacyInteractiveLoopResume
    ? (loopGateRunMeta.loop_user_input ?? '')
    : '';

  // Finalize-on-approve (#2074): mirrors executeLoopNode — a completion-bearing gate
  // resumed WITHOUT feedback completes the group from the persisted output instead
  // of re-running the body.
  if (isLoopResume && loopGateMeta?.completionSignaled === true && !feedbackGiven) {
    const finalizeOutput = loopGateMeta.signaledOutput ?? '';
    // The signaled iteration's structured payload (#2637): attaching it keeps this
    // route's `$group.output.field` tier IDENTICAL to natural completion (tier-2
    // lenient) — without it the same absent optional field would throw here and
    // resolve to '' there. null/absent (pre-#2637 gates) → text-only, as before.
    const finalizeStructured = loopGateMeta.signaledStructuredOutput ?? null;
    await safeSendMessage(
      platform,
      conversationId,
      `Loop-group node '${node.id}' accepted after a completion condition was met (no re-run)`,
      { workflowId: workflowRun.id, nodeName: node.id }
    );
    return {
      state: 'completed',
      output: finalizeOutput,
      ...(finalizeStructured !== null ? { structuredOutput: finalizeStructured } : {}),
    };
  }

  if (isEscalatedWaitResume) {
    const terminalNode = findLoopGroupTerminalSuspendNode(bodyNodes);
    if (terminalNode?.kind !== 'wait') {
      throw new Error(`Loop group '${node.id}' resumed with wait state but has no terminal wait`);
    }
    const waitOutput = await executeWaitNode(
      {
        ...ctx,
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
        ...snapshotBodySessionCursorAncestry(bodySessionCursorAncestry),
      }
    );
    const status = await deps.store.getWorkflowRunStatus(workflowRun.id);
    if (status === 'paused') {
      return {
        state: 'running',
        output: '',
        loopIterations: resumeIteration,
        suspensionPoint: 'wait',
      };
    }
    outerNodeOutputs.set(bodyStepNamePrefix + terminalNode.id, waitOutput);
  }

  let loopPrevOutputs: Map<string, NodeOutput> | undefined; // undefined on iteration 1
  // Restore the body-output snapshot $LOOP_PREV.* reads, for the resumed iteration
  // (#2748). The pause boundary discards this function's local state, but the last
  // iteration's direct body-node outputs already survive as persisted
  // `<groupId>.<bodyId>` node_completed rows — `outerNodeOutputs` was ALREADY
  // pre-populated from them (the run's resume pre-population in restoreRunState, itself
  // sourced from getDagResumeSnapshot's #2726/#2732 bounded-rows + spill/rehydrate
  // read), keyed by that full step name. Re-key to the bare body id so
  // the loop scope finds them exactly as it would mid-loop.
  if (isLoopResume) {
    const restoredLoopPrevOutputs = new Map<string, NodeOutput>();
    const bodyNodesById = new Map(bodyNodes.map(n => [n.id, n]));
    for (const id of directBodyIds) {
      const prior = outerNodeOutputs.get(bodyStepNamePrefix + id);
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
    if (restoredLoopPrevOutputs.size > 0) loopPrevOutputs = restoredLoopPrevOutputs;
  }

  // #2707 step 3: an escalated gate-terminated-body resume might already be
  // "done" — the human's answer, just reconstructed above (the SAME restoration
  // #2748 built for $LOOP_PREV, now also finding the gate's own resolution
  // thanks to the namespaced write-path fix), may satisfy the group's own
  // until_bash. The legacy interactive_loop resume always advances blindly to
  // iteration+1; that would be WRONG here — it would silently start a whole new
  // iteration (re-running the body's pre-gate work) while ignoring an answer
  // that already meant "stop". Re-run the same completion check the normal
  // per-iteration path runs below, fed from the reconstructed data instead of a
  // fresh runLayers call — decision (b) settled that resume re-enters at the
  // iteration boundary, so the pre-gate body nodes' already-produced outputs are
  // safe to reuse as-is; only the gate's own answer needed reconstructing.
  if ((isEscalatedGateResume || isEscalatedWaitResume) && loopPrevOutputs !== undefined) {
    const terminalNode = findLoopGroupTerminalSuspendNode(bodyNodes);
    if (terminalNode !== undefined && loopPrevOutputs.has(terminalNode.id)) {
      const resumedResult = loopGroupIterationOutput(bodyNodes, loopPrevOutputs);
      const resumedIteration = resumeIteration;
      const rawIterationOutput = resumedResult?.output ?? '';
      const resumedSignalDetected =
        group.until !== undefined && detectCompletionSignal(rawIterationOutput, group.until);
      let resumedBashComplete = false;
      if (group.until_bash && !resumedSignalDetected) {
        // Fresh observation for this resumed iteration's condition.
        const typedArtifactsFile = await writeNodeArtifactsListing(artifactsDir, workflowRun.id);
        // No $LOOP_PREV history survives a resume beyond the single reconstructed
        // iteration above — #2748 restores only the LATEST persisted body outputs,
        // not a full history — so an until_bash referencing $LOOP_PREV from the
        // iteration BEFORE this one resolves empty here, same as a fresh
        // iteration 1. Not expected to matter in practice: Design A's canonical
        // pattern reads only $<gateId>.output inside until_bash, never $LOOP_PREV.
        // Merge outer-DAG outputs underneath the reconstructed body outputs —
        // mirrors how a normal (non-resumed) iteration seeds scopedNodeOutputs
        // (`new Map(outerNodeOutputs)`, then overwritten by this iteration's own
        // body results) — so an until_bash combining an outer-scope ref with the
        // gate's own decision resolves the outer ref correctly on resume too,
        // not just mid-loop. outerNodeOutputs is already an in-scope parameter;
        // no new reconstruction needed.
        const resumedScope = new Map([...outerNodeOutputs, ...loopPrevOutputs]);
        const { prompt: resumedSubstitutedBash } = substituteWorkflowVariables(
          group.until_bash,
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
            references: nodeTemplateReferences(
              group.until_bash,
              { nodeOutputs: resumedScope, loopBodyScopes: ctx.loopBodyScopes },
              'shell',
              {
                artifactsDir,
                requiredContext: { consumerId: node.id, field: 'loop_group.until_bash' },
              }
            ),
          }
        );
        const resumedBashPath = resolveBashPath();
        try {
          await runSubprocessUntilRunStops(
            deps.store,
            workflowRun.id,
            node.id,
            execContext,
            resumedBashPath,
            ['-c', resumedSubstitutedBash],
            {
              cwd,
              timeout: node.timeout,
              protectedEnvKeys: config.protectedEnvKeys,
              protectedCredentialValues: config.protectedCredentialValues,
              retention: {
                logDir,
                workflowRunId: workflowRun.id,
                nodeId: `${node.id}-iteration-${String(resumedIteration)}`,
                label: '<until_bash>',
              },
              env: buildNodeShellEnvironment(node, ctx, config.envVars, {
                artifactsDir,
                stateDir,
                logDir,
                workflowId: workflowRun.id,
                baseBranch,
                userMessage: workflowRun.user_message,
                loopUserInput: '',
                loopPrevOutput: '',
                rejectionReason: '',
                issueContext,
                adoptedRunDir: currentAdoptedRunDir(),
                typedArtifactsFile,
                nodeExecution: ctx.currentExecution ?? null,
              }),
            }
          );
          resumedBashComplete = true;
        } catch (e) {
          const bashErr = e as RawSubprocessRejection;
          if (bashErr.cancelled) {
            return {
              state: 'failed',
              output: '',
              error: bashErr.message,
              failureKind: 'cancelled',
              ...usage,
            };
          }
          if (hostSpawnFailure(execContext, bashErr) !== undefined) {
            getLog().error(
              { err: bashErr, nodeId: node.id, iteration: resumedIteration },
              'loop_group.until_bash_failed'
            );
            throw new Error(
              `Loop group '${node.id}' until_bash failed: cannot execute bash at ` +
                `'${resumedBashPath}' (${bashErr.code}). Set ARCHON_BASH_PATH if Git Bash ` +
                'is installed elsewhere.'
            );
          }
          if (typeof bashErr.code !== 'number') {
            getLog().error(
              { err: bashErr, nodeId: node.id, iteration: resumedIteration },
              'loop_group.until_bash_unexpected_error'
            );
            throw bashErr;
          }
          resumedBashComplete = false;
        }
      }
      if (resumedSignalDetected || resumedBashComplete) {
        const resumedOutput = stripCompletionTags(rawIterationOutput, group.until);
        const resumedStructuredOutput =
          resumedResult !== undefined && 'structuredOutput' in resumedResult
            ? resumedResult.structuredOutput
            : undefined;
        await safeSendMessage(
          platform,
          conversationId,
          `Loop-group node '${node.id}' completed after ${String(resumedIteration)} iteration${resumedIteration > 1 ? 's' : ''}`,
          msgContext
        );
        return {
          state: 'completed',
          output: resumedOutput,
          loopIterations: resumedIteration,
          ...(resumedStructuredOutput !== undefined
            ? { structuredOutput: resumedStructuredOutput }
            : {}),
        };
      }
      // Not complete — fall through. startIteration is already iteration+1 (set
      // above from loopGateMeta.iteration), so the for loop below proceeds into a
      // genuinely fresh iteration, exactly as it would for any other resume.
    }
  }

  // A resumed group continues from the iteration it paused in; that iteration's
  // restored body outputs give until_bash its LOOP_PREV_OUTPUT.
  let lastIterationOutput =
    loopPrevOutputs === undefined
      ? ''
      : stripCompletionTags(
          loopGroupIterationOutput(bodyNodes, loopPrevOutputs)?.output ?? '',
          group.until
        );
  // The terminal sink's structured payload for the same iteration (#2637) — tracked
  // beside the text so the group's completed NodeOutput carries the logical value
  // (sibling `loop:` has done this since #2563; the group used to discard it).
  let lastIterationStructuredOutput: unknown;
  // Loop-level session cursor: threaded across iterations when fresh_context is false
  // (so a body AI node resumes the prior iteration's session), reset to undefined when
  // fresh_context is true or on iteration 1. runLayers mutates this in place each call.
  // On interactive resume, restore the cursor persisted at pause time so
  // fresh_context: false continues the pre-pause conversation (mirrors executeLoopNode).
  // The provider tag must be restored WITH the session id (#1992) — metadata from a
  // pre-tag pause lacks it, and restoring an untagged cursor could thread the session
  // into a different provider on resume, so those legacy pauses restore fresh instead.
  const resumedLoopSessionId = loopGateMeta?.sessionId ?? loopOwnedWaitMeta?.sessionId;
  const resumedLoopSessionProvider =
    loopGateMeta?.sessionProvider ?? loopOwnedWaitMeta?.sessionProvider;
  let loopLastSequentialSession: SequentialSessionCursor | undefined =
    isLoopResume &&
    typeof resumedLoopSessionId === 'string' &&
    typeof resumedLoopSessionProvider === 'string'
      ? {
          sessionId: resumedLoopSessionId,
          provider: resumedLoopSessionProvider,
        }
      : undefined;

  const logEventStoreError = (err: Error, iteration: number): void => {
    getLog().error({ err, nodeId: node.id, iteration }, 'loop_group_node.iteration_event_failed');
  };

  for (let i = startIteration; i <= iterationLimit; i++) {
    const iterationStart = Date.now();

    // Between-iteration status check (paused tolerated — mirrors executeLoopNode).
    const runStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
    if (!shouldContinueStreamingForStatus(runStatus)) {
      const effectiveStatus = runStatus ?? 'deleted';
      getLog().info(
        { workflowRunId: workflowRun.id, nodeId: node.id, iteration: i, status: effectiveStatus },
        'loop_group_node.stop_detected'
      );
      await safeSendMessage(
        platform,
        conversationId,
        `Loop-group node '${node.id}' stopped at iteration ${String(i)} (${effectiveStatus})`,
        msgContext
      );
      return {
        state: 'failed',
        output: '',
        error: `Workflow ${effectiveStatus}`,
        failureKind: 'cancelled',
        ...usage,
      };
    }

    // Emit iteration started.
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

    // This iteration's $LOOP_PREV.* outputs and $LOOP_USER_INPUT reply, which every body
    // node resolves through iterCtx.loopBodyScopes. On iteration 1 loopPrevOutputs is
    // undefined → $LOOP_PREV refs resolve to ''; $LOOP_USER_INPUT is '' except on the first
    // resumed iteration of an interactive loop.
    const prevSnapshot = loopPrevOutputs;
    const userInputForIter = isLoopResume && i === startIteration ? loopUserInput : '';
    const iterScope = loopBodyScope(bodyNodes, prevSnapshot, userInputForIter, artifactsDir);
    const iterBodyLayers = planGraph(bodyNodes).layers;

    // Fresh scoped output map per iteration. Seed it read-only with the outer DAG's
    // upstream outputs so body nodes can reference outer context via $nodeId.output if
    // needed (the body is sealed against depends_on, but prompt refs remain valid).
    const scopedNodeOutputs = new Map<string, NodeOutput>(outerNodeOutputs);

    const terminalSuspendNode = findLoopGroupTerminalSuspendNode(bodyNodes);
    const iterCtx: RunLayersContext = {
      toolAttention: ctx.toolAttention,
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
      workflowProvider,
      // The group's own resolved provider and model become the body's defaults, the
      // pair the schema documents. `workflowModel` already carries the group's model
      // when it declared one and the enclosing workflow's otherwise, so body AI nodes
      // resolve aliases and defaults the same way top-level nodes do, and a per-node
      // `model:` in the body still wins over both.
      workflowModel,
      // The tier and preset travel WITH the model. A tier ref resolves to a provider,
      // a model and an effort as one unit; forwarding the model while leaving the
      // enclosing tier and preset in place would run the group's model, attribute it to
      // the workflow's tier, and apply the workflow preset's effort to it.
      workflowLevelOptions: { ...ctx.workflowLevelOptions, workflowTier },
      aiProfile: ctx.aiProfile,
      workflowPreset,
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
      bodySessionCursors,
      bodySessionCursorAncestry,
      lastSequentialSession: group.fresh_context || i === 1 ? undefined : loopLastSequentialSession,
      warnedProviderConflicts: ctx.warnedProviderConflicts,
      totalCostUsd: undefined,
      totalTokens: undefined,
      totalTokensUnknown: false,
      stepNamePrefix: bodyStepNamePrefix,
      loopGroupPath: [...ctx.loopGroupPath, { groupId: node.id, iteration: i }],
      // Deliver this iteration's approval-gate free-text to body exec: nodes via env
      // (#2115, #2725). Script bodies use this as their ONLY channel (their loop scope leaves
      // the literal token alone, unsafe to splice into TS/Python source). Bash bodies get
      // it as a SECOND channel — their loop scope shell-quotes the literal
      // "$LOOP_USER_INPUT" token into the script source; this env var covers indirect reads
      // (${LOOP_USER_INPUT}, printenv, env) that splice can't reach.
      bodyLoopUserInput: userInputForIter,
      loopPrevOutputs: prevSnapshot ?? new Map(),
      loopBodyScopes: [...ctx.loopBodyScopes, iterScope],
    };
    await runLayers(iterCtx);

    // Accumulate usage across iterations (charged on the failure path below too).
    if (iterCtx.totalCostUsd !== undefined) {
      usage.costUsd = (usage.costUsd ?? 0) + iterCtx.totalCostUsd;
    }
    usage.tokensUnknown ||= iterCtx.totalTokensUnknown;
    if (usage.tokensUnknown) {
      usage.tokens = undefined;
    } else if (iterCtx.totalTokens !== undefined) {
      usage.tokens = sumTokenUsage(
        [...(usage.tokens !== undefined ? [usage.tokens] : []), iterCtx.totalTokens],
        { nodeId: node.id, iteration: i }
      );
    }

    // A body approval/cancel node may have paused or cancelled the run mid-iteration.
    // `paused` is tolerated (a sibling gate in the same iteration layer) — mirror
    // executeLoopNode's between-iteration tolerance — but a terminal/cancelled state
    // means the loop must stop now, skipping snapshot/completion handling for this
    // iteration. Re-check before proceeding.
    const postBodyStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
    // null (run row gone / deleted) is a stop condition too — treat it as 'deleted'.
    if (!shouldContinueStreamingForStatus(postBodyStatus)) {
      const effectiveStatus = postBodyStatus ?? 'deleted';
      getLog().info(
        { workflowRunId: workflowRun.id, nodeId: node.id, iteration: i, status: effectiveStatus },
        'loop_group_node.post_body_stop'
      );
      return {
        state: 'failed',
        output: lastIterationOutput,
        error: `Workflow ${effectiveStatus}`,
        failureKind: 'cancelled',
        ...usage,
      };
    }
    // Carry the body's final sequential session into the next iteration (unless
    // fresh_context forces a reset, handled above by seeding undefined). Taken
    // before handling the terminal gate below: its pause persists this
    // cursor, and a cursor from before the paused iteration would resume without
    // that iteration's turns (#3532).
    loopLastSequentialSession = iterCtx.lastSequentialSession;

    // A failed body node fails the group immediately — mirrors the top-level DAG
    // (any failed node fails the run) and executeLoopNode (an iteration failure stops
    // the loop). Silently re-running the body would burn AI cost every remaining
    // iteration and bury the root cause under a generic max-iterations error.
    const failedBodyOutputs = bodyNodes.flatMap(n => {
      const o = scopedNodeOutputs.get(n.id);
      return o?.state === 'failed' ? [{ id: n.id, output: o }] : [];
    });
    if (failedBodyOutputs.length > 0) {
      const failedBodyNodes = failedBodyOutputs.map(({ id, output }) => `'${id}': ${output.error}`);
      const providerFailure = aggregateProviderFailure(
        failedBodyOutputs.map(({ output }) => output.providerFailure),
        Date.now()
      );
      const errorMsg = `Loop-group node '${node.id}' failed at iteration ${String(i)}: ${failedBodyNodes.join('; ')}`;
      getLog().warn(
        { nodeId: node.id, iteration: i, failedCount: failedBodyNodes.length },
        'loop_group_node.body_node_failed'
      );
      await safeSendMessage(platform, conversationId, errorMsg, msgContext);
      return {
        state: 'failed',
        output: lastIterationOutput,
        error: errorMsg,
        failureKind: 'child_failed',
        ...(providerFailure !== undefined ? { providerFailure } : {}),
        ...usage,
        loopIterations: i,
      };
    }

    if (terminalSuspendNode && postBodyStatus === 'paused') {
      const suspendOutput = scopedNodeOutputs.get(terminalSuspendNode.id);
      // Still running means the terminal gate or wait either suspended this group or was
      // deferred behind a sibling that holds the paused slot. Either way the iteration
      // stops here; only a suspension this group owns is marked as one.
      if (suspendOutput === undefined || suspendOutput.state === 'running') {
        let suspensionPoint: 'approval' | 'wait' | undefined;
        if (isGateNode(terminalSuspendNode)) {
          if (suspendOutput?.execution?.lifecycle.status === 'suspended') {
            suspensionPoint = 'approval';
          }
        } else {
          const freshRun = await deps.store.getWorkflowRun(workflowRun.id);
          const freshWait = freshRun?.metadata?.wait;
          if (
            isWorkflowWaitContext(freshWait) &&
            freshWait.owner === 'loop_group' &&
            freshWait.nodeId === node.id &&
            freshWait.bodyWaitId === terminalSuspendNode.id &&
            freshWait.iteration === i
          ) {
            suspensionPoint = 'wait';
          }
        }
        return {
          state: 'running',
          output: lastIterationOutput,
          ...usage,
          loopIterations: i,
          ...(suspensionPoint !== undefined ? { suspensionPoint } : {}),
        };
      }
    }

    if (
      postBodyStatus === 'paused' &&
      bodySessionCursorAncestry.size > 0 &&
      bodyNodes.some(
        n => n.kind === 'loop_group' && scopedNodeOutputs.get(n.id)?.state === 'running'
      )
    ) {
      return {
        state: 'running',
        output: lastIterationOutput,
        ...usage,
        loopIterations: i,
      };
    }

    // Carry prior-iteration snapshot forward for $LOOP_PREV.* on the next iteration.
    loopPrevOutputs = new Map(scopedNodeOutputs);

    // DELIBERATELY NOT `returns:`-aware (#2470): a loop_group's per-iteration output is
    // the iteration's own result, not a caller contract — `returns:` selects a WORKFLOW's
    // result and only rebinds a child run's terminal output (see executeDagWorkflow). Leave
    // this positional scan as-is; do not "fix" the inconsistency.
    const iterationResult = loopGroupIterationOutput(bodyNodes, scopedNodeOutputs);
    const iterationOutput = iterationResult?.output ?? '';
    // Capture the PREVIOUS iteration's (cleaned) output before overwriting — the
    // until_bash env below exposes it as LOOP_PREV_OUTPUT (previous iteration, same
    // semantics as executeLoopNode; empty on the first iteration).
    const prevIterationOutput = lastIterationOutput;
    // Signal detection uses the raw output; the stored/returned output is stripped of
    // completion-signal tags so the marker never leaks into $groupId.output (mirrors
    // executeLoopNode's cleanOutput handling).
    lastIterationOutput = stripCompletionTags(iterationOutput, group.until);
    // The sink's structured payload rides along AS-IS (#2637): a JSON payload never
    // contains the completion tag, so no stripping applies to it.
    lastIterationStructuredOutput =
      iterationResult !== undefined && 'structuredOutput' in iterationResult
        ? iterationResult.structuredOutput
        : undefined;

    // Completion gate: until-signal in the terminal output, and/or until_bash exit 0.
    // Short-circuit: if the until-signal already detected completion, skip the
    // until_bash subprocess (avoids unnecessary side effects and shell cost) — OR
    // semantics mean the group is already complete.
    //
    // `until` is optional (#2563): a group that declared only `until_bash` has no
    // prose path at all, so never call detectCompletionSignal with an undefined
    // signal — its regexes would be built from the empty string and match anything.
    const signalDetected =
      group.until !== undefined && detectCompletionSignal(iterationOutput, group.until);

    let bashComplete = false;
    if (group.until_bash && !signalDetected) {
      // Resolve outside the try so ARCHON_BASH_PATH validation errors bubble up
      // to the caller instead of being swallowed by the per-iteration catch.
      const groupBashPath = resolveBashPath();
      // Observed after the body ran, so the condition sees the typed artifacts this
      // iteration published. Outside the try: a materialization fault is a
      // provisioning error, not an unreachable bash binary.
      const typedArtifactsFile = await writeNodeArtifactsListing(artifactsDir, workflowRun.id);
      try {
        // Resolve this group's own cross-iteration refs against the snapshot captured
        // before its body ran. `loopPrevOutputs` now contains the CURRENT iteration, so
        // using it here would collapse `$LOOP_PREV` into `$node.output` semantics. Only
        // direct body ids belong to this scope; refs owned by an enclosing group resolve
        // through that group's scope ahead of this one, and descendant ids are not
        // present in this group's per-iteration output map.
        const ownScope: LoopBodyScope = {
          loopPrevOutputs: prevSnapshot,
          outputFileDir: logDir,
          knownBodyIds: directBodyIds,
          directBodyIds,
        };
        const { prompt: substitutedBash } = substituteWorkflowVariables(
          group.until_bash,
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
            references: nodeTemplateReferences(
              group.until_bash,
              {
                nodeOutputs: scopedNodeOutputs,
                loopBodyScopes: [...ctx.loopBodyScopes, ownScope],
              },
              'shell',
              {
                artifactsDir,
                requiredContext: { consumerId: node.id, field: 'loop_group.until_bash' },
              }
            ),
          }
        );
        await runSubprocessUntilRunStops(
          deps.store,
          workflowRun.id,
          node.id,
          execContext,
          groupBashPath,
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
              nodeExecution: ctx.currentExecution ?? null,
            }),
          }
        );
        bashComplete = true;
      } catch (e) {
        const bashErr = e as RawSubprocessRejection;
        if (bashErr.cancelled) {
          return {
            state: 'failed',
            output: '',
            error: bashErr.message,
            failureKind: 'cancelled',
            ...usage,
          };
        }
        // System-level errors (ENOENT/EACCES/ENOTDIR) mean the bash binary itself
        // is unreachable — looping forever on bashComplete=false is wrong. Throw
        // out of the group with a clear actionable error instead (mirrors
        // executeLoopNode's until_bash handling).
        if (hostSpawnFailure(execContext, bashErr) !== undefined) {
          getLog().error(
            { err: bashErr, nodeId: node.id, iteration: i },
            'loop_group.until_bash_failed'
          );
          throw new Error(
            `Loop group '${node.id}' until_bash failed: cannot execute bash at ` +
              `'${groupBashPath}' (${bashErr.code}). Set ARCHON_BASH_PATH if Git Bash ` +
              'is installed elsewhere.'
          );
        }
        // Non-exec errors (template substitution, etc.) have no err.code — they
        // should halt the group, not silently re-iterate.
        if (typeof bashErr.code !== 'number') {
          getLog().error(
            { err: bashErr, nodeId: node.id, iteration: i },
            'loop_group.until_bash_unexpected_error'
          );
          throw bashErr;
        }
        // Numeric exit code from the bash script = condition not met yet, keep looping.
        bashComplete = false;
      }
    }

    const completionChecks: LoopCompletionCheck[] = [];
    if (group.until !== undefined) {
      completionChecks.push({ channel: 'until', signal: group.until, completed: signalDetected });
    }
    if (group.until_bash !== undefined) {
      completionChecks.push({ channel: 'until_bash', completed: bashComplete });
    }

    const duration = Date.now() - iterationStart;
    const completionDetected = completionChecks.some(check => check.completed);

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
        data: { iteration: i, duration, completionDetected, nodeId: node.id },
      })
      .catch((err: Error) => {
        logEventStoreError(err, i);
      });

    // Completion: honor the completed iteration only when the AI had input to evaluate (interactive
    // first run always gates first — mirrors executeLoopNode's interactiveFirstRun),
    // UNLESS the author opted into autonomous completion via signal_completes (#2074).
    const interactiveFirstRun = group.interactive && !isLoopResume;
    const signalCompletes = group.signal_completes === true;
    if (completionDetected && (!interactiveFirstRun || signalCompletes)) {
      await safeSendMessage(
        platform,
        conversationId,
        `Loop-group node '${node.id}' completed after ${String(i)} iteration${i > 1 ? 's' : ''}`,
        msgContext
      );
      return {
        state: 'completed',
        output: lastIterationOutput,
        ...usage,
        loopIterations: i,
        // The final iteration's sink payload, so downstream `$group.output.field`
        // resolves from the logical value (#2637). No declaredOutputPaths: a group's
        // own output_format is ignored, so field access stays tier-2 lenient.
        ...(lastIterationStructuredOutput !== undefined
          ? { structuredOutput: lastIterationStructuredOutput }
          : {}),
      };
    }

    // Interactive gate — pause after an iteration that did not complete (or, when
    // interactiveFirstRun && !signalCompletes, an iteration that DID complete — the honest
    // status line + persisted completion state (#2074) let a bare approve finalize it).
    if (group.interactive && group.gate_message) {
      const honestMessage = buildHonestGateMessage(
        completionChecks,
        lastIterationOutput,
        group.gate_message
      );
      const suspended = finishNodeExecution(
        execution,
        { status: 'suspended', point: 'interactive_loop' },
        {
          output: { text: lastIterationOutput, structured: lastIterationStructuredOutput },
          ...usage,
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
        sessionId: loopLastSequentialSession?.sessionId ?? null,
        sessionProvider: loopLastSequentialSession?.provider ?? null,
        ...(bodySessionCursors !== undefined
          ? { bodySessionCursors: Object.fromEntries(bodySessionCursors) }
          : {}),
        ...snapshotBodySessionCursorAncestry(bodySessionCursorAncestry),
        // Signal state for finalize-on-bare-approve (#2074). The structured payload
        // rides along (#2637) so the finalize attaches it like a natural completion.
        completionSignaled: completionDetected,
        signaledOutput: completionDetected ? lastIterationOutput : null,
        signaledStructuredOutput: completionDetected
          ? (lastIterationStructuredOutput ?? null)
          : null,
        // NO `signaledTokens` — a loop_group gate has no consumer for it. The body's
        // own `<groupId>.<nodeId>` rows already persisted this iteration's usage before
        // the pause, so the finalize path deliberately writes no `tokens` (see the
        // finalizeLoopFromSignal call above). Only the plain `loop` gate carries it.
      };
      const paused = await pauseGateRespectingExternalTransition(
        deps,
        workflowRun.id,
        approvalContext,
        { event: serializeNodeStateRecord(suspended) }
      );
      if (!paused)
        return {
          state: 'running',
          output: lastIterationOutput,
          ...usage,
          loopIterations: i,
        };
      await recordDerivedExecution({ logDir }, suspended);
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

  // Max iterations exceeded.
  const errorMsg = `Loop-group node '${node.id}' exceeded max iterations (${String(iterationLimit)}) ${describeUnmetCompletion(group)}`;
  getLog().warn(
    { nodeId: node.id, maxIterations: iterationLimit, signal: group.until },
    'loop_group_node.max_iterations_reached'
  );
  await safeSendMessage(platform, conversationId, errorMsg, msgContext);
  return {
    state: 'failed',
    output: lastIterationOutput,
    error: errorMsg,
    failureKind: 'max_iterations',
    ...usage,
    // A bare approve past the cap resumes beyond iterationLimit and runs nothing.
    loopIterations: Math.max(iterationLimit, startIteration - 1),
  };
}
