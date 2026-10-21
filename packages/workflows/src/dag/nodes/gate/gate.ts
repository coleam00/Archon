import { executionClaim } from '../../../store';
import { executeAgentNode } from '../agent/agent';
import {
  pauseGateRespectingExternalTransition,
  sendPauseNotice,
  snapshotBodySessionCursorAncestry,
} from '../../pause';
import { gateReworkNode } from '../../../gate-rework';
import { finishNodeExecution, executionMetadata } from '../../../node-execution';
import {
  serializeNodeStateRecord,
  serializeNodeOutput,
  type NodeExecutionResult,
} from '../../../node-record-serialization';
import { recordDerivedExecution, recordNodeState } from '../../../node-event-write';
import { spellWorkflowCommand } from '../../../deps';
import { approvalContextSchema, gateOccurrence } from '../../../schemas/workflow-run';
import type { GateNode } from '../../../schemas';
import { isApprovalContext } from '../../../schemas';
import { getWorkflowEventEmitter } from '../../../event-emitter';
import { requireTerminalStatusWrite } from '../../../terminal-status-write';
import { writeNodeArtifactsListing } from '../../../artifacts-index';
import { safeSendMessage } from '../../../platform-messages';
import { getLog } from '../../log';
import { beginExecution, type RunLayersContext } from '../../run-context';
import { substituteNodeOutputRefs } from '../../references';
import { runBudgetedAttempt } from '../../retry';
import { resolveNodeProviderAndModel } from '../../provider-resolution';

/**
 * Execute an approval node — pauses workflow for human review.
 * On rejection resume (when on_reject is configured): runs the on_reject prompt via AI,
 * then re-pauses at the approval gate. After max_attempts rejections, cancels normally.
 */
export async function executeApprovalNode(
  ctx: RunLayersContext,
  node: GateNode
): Promise<NodeExecutionResult> {
  const { stepNamePrefix } = ctx;
  const iteration = ctx.loopGroupPath.at(-1)?.iteration;
  const { workflowRun, deps, platform, conversationId, artifactsDir, nodeOutputs } = ctx;
  const msgContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Namespaced persisted step_name for loop_group bodies ('' → node.id at top level, #2090).
  const stepName = stepNamePrefix + node.id;
  const execution = beginExecution(ctx, node);
  await recordNodeState({ store: deps.store, logDir: ctx.logDir }, execution);

  // Detect rejection resume — check metadata for rejection_reason set by reject handlers.
  // Strict `=== 'approval'` excludes `undefined`: a pre-#936 run paused before the
  // `type` field existed and rejected-with-rework would stage a rework
  // `rejectWorkflow` treats as equivalent to `type: 'approval'` but this check
  // won't recognize — legacy-only, pre-existing, not touched by #2489.
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

  // On rejection resume with a rework continuation configured: run its prompt via AI
  let reworkUsage: Pick<NodeExecutionResult, 'costUsd' | 'tokens' | 'tokensUnknown'> = {};
  const rejectDecision = node.decisions.find(d => d.id === 'reject');
  const rework = rejectDecision?.rework;
  if (rejectionReason !== '' && rework) {
    const maxAttempts = rework.maxAttempts ?? 3;
    const rejectionCount = (workflowRun.metadata?.rejection_count as number | undefined) ?? 0;

    // Check if max attempts exhausted
    if (rejectionCount >= maxAttempts) {
      const reason = `max_attempts (${String(maxAttempts)}) exhausted`;
      await requireTerminalStatusWrite(
        deps.store.cancelWorkflowRun(workflowRun.id, {
          step_name: stepName,
          reason,
          cancel_reason: 'approval_rejected',
        }),
        { workflowRunId: workflowRun.id, site: 'dag.approval_exhausted_cancel' }
      );
      getWorkflowEventEmitter().emit({
        type: 'workflow_cancelled',
        runId: workflowRun.id,
        nodeId: node.id,
        reason,
      });
      const cancelMsg = `❌ Approval node \`${node.id}\` cancelled after ${String(maxAttempts)} rejections.`;
      await safeSendMessage(platform, conversationId, cancelMsg, msgContext);
      return { state: 'completed' as const, output: '' };
    }

    // Materialize the listing before substitution so a rework prompt may reference
    // $TYPED_ARTIFACTS_FILE. Fresh per rework attempt: the approval's rework node is an
    // ordinary agent invocation, so it observes artifacts published before this attempt.
    const typedArtifactsFile = await writeNodeArtifactsListing(artifactsDir, workflowRun.id);

    // Build a synthetic PromptNode to reuse executeAgentNode.
    // Use a distinct ID so the node_completed event written by executeAgentNode
    // does not collide with the approval gate's own ID in the resume snapshot.
    // If we used node.id here, a resumed run would find the event and treat the
    // approval gate as already completed, bypassing the human gate entirely.
    //
    // Note: executeAgentNode also emits node_started/node_completed WorkflowEmitterEvents
    // with nodeId = `${node.id}:on_reject`. These flow through SSE into the web UI, where
    // WorkflowExecution.tsx builds its nodeMap from all node_* events unconditionally.
    // This means a transient `${node.id}:on_reject` phantom entry may appear in the UI's
    // execution view during an on_reject cycle. This is cosmetic-only — the approval gate
    // still re-presents correctly and the human gate contract is preserved. A follow-up can
    // filter synthetic `:on_reject` IDs from the UI's nodeMap if needed.
    //
    // The synthetic node carries the rework TEMPLATE: executeAgentNode resolves it, with
    // the rejection reason, in the one pass every agent prompt gets.
    const syntheticNode = gateReworkNode(node, rework.prompt);

    const {
      provider,
      model: resolvedNodeModel,
      options: nodeOptions,
      tier: resolvedTier,
      effort: resolvedEffort,
    } = await resolveNodeProviderAndModel(ctx, syntheticNode, {
      // Engine-synthesised from `approval.on_reject.prompt` alone — it carries no
      // systemPrompt/agents, so there is no AI-configuration text to resolve.
      resolveAiText: text => text,
      // Also carries no `model:`, so it cannot raise a provider conflict to de-duplicate.
      warnedProviderConflicts: undefined,
    });

    const output = await runBudgetedAttempt(ctx, syntheticNode, reserve =>
      executeAgentNode(
        ctx,
        syntheticNode,
        reserve,
        provider,
        nodeOptions,
        undefined, // fresh session
        resolvedNodeModel,
        resolvedTier,
        resolvedEffort,
        stepNamePrefix,
        iteration,
        undefined, // synthetic on_reject node never carries a session checkpoint
        typedArtifactsFile,
        'ordinary',
        rejectionReason
      )
    );

    if (output.state === 'failed') {
      return output;
    }
    // The synthetic event owns durable spend; this return carries it to current-pass totals.
    reworkUsage = {
      costUsd: output.costUsd,
      tokens: output.tokens,
      tokensUnknown: output.tokensUnknown,
    };
  }

  // Resolve $nodeId.output[.field] references so the human sees concrete values
  // (parity with prompt/bash/loop/cancel nodes, which all run the same substitution).
  const renderedMessage = substituteNodeOutputRefs(node.message, nodeOutputs, ctx.loopBodyScopes);
  const choices = node.decisions.map(decision => {
    const label =
      decision.label ??
      (decision.id === 'approve' ? 'Approve' : decision.id === 'reject' ? 'Reject' : decision.id);
    const display = decision.label ? `${label} (${decision.id})` : label;
    const command =
      decision.id === 'approve' || decision.id === 'reject'
        ? `${decision.id} ${workflowRun.id}`
        : `respond ${workflowRun.id} ${decision.id} [text]`;
    return `${display}: \`${spellWorkflowCommand(platform, command)}\``;
  });
  const suspended = finishNodeExecution(
    execution,
    { status: 'suspended', point: 'approval' },
    {
      output: { text: '' },
      diagnostics: { iteration },
    }
  );
  const bodyGateOwner = ctx.bodyGateOwner?.bodyGateId === node.id ? ctx.bodyGateOwner : undefined;
  const approvalContext = approvalContextSchema.parse({
    execution: executionMetadata(suspended),
    message: renderedMessage,
    nodeId: bodyGateOwner?.nodeId ?? node.id,
    ...(bodyGateOwner
      ? {
          bodyGateId: bodyGateOwner.bodyGateId,
          iteration: bodyGateOwner.iteration,
          sessionId: ctx.lastSequentialSession?.sessionId ?? null,
          sessionProvider: ctx.lastSequentialSession?.provider ?? null,
          ...(ctx.bodySessionCursors !== undefined
            ? { bodySessionCursors: Object.fromEntries(ctx.bodySessionCursors) }
            : {}),
          ...snapshotBodySessionCursorAncestry(ctx.bodySessionCursorAncestry),
        }
      : {}),
    type: 'approval',
    captureResponse: node.captureResponse,
    onRejectPrompt: rework?.prompt,
    onRejectMaxAttempts: rework?.maxAttempts,
    decisions: node.decisions.map(d => ({
      id: d.id,
      ...(d.label !== undefined ? { label: d.label } : {}),
    })),
    decisionsAuthored: node.decisionsAuthored,
  });
  const paused = await pauseGateRespectingExternalTransition(
    deps,
    workflowRun.id,
    approvalContext,
    {
      event: serializeNodeStateRecord(suspended),
      expectedExecutionClaim: executionClaim(workflowRun.metadata),
    }
  );
  switch (paused.kind) {
    case 'deferred':
      await recordNodeState({ store: deps.store, logDir: ctx.logDir }, suspended);
      return { ...serializeNodeOutput(execution), ...reworkUsage };
    case 'external_transition':
      return { ...serializeNodeOutput(execution), ...reworkUsage };
  }
  await recordDerivedExecution({ logDir: ctx.logDir }, suspended);
  const approvalMsg =
    `⏸ **Approval required**: ${renderedMessage}\n\n` +
    `Run ID: \`${workflowRun.id}\`\n` +
    choices.join(' | ');
  await sendPauseNotice(
    deps,
    platform,
    conversationId,
    workflowRun.id,
    node.id,
    gateOccurrence(paused.approval),
    stepName,
    approvalMsg
  );

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'approval_requested',
      step_name: stepName,
      data: { message: renderedMessage },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'approval_requested' },
        'workflow.event_persist_failed'
      );
    });

  return { ...serializeNodeOutput(suspended), ...reworkUsage };
}
