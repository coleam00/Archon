import { randomUUID } from 'node:crypto';
import type { IWorkflowPlatform, WorkflowDeps } from '../deps';
import { getWorkflowEventEmitter } from '../event-emitter';
import { safeSendMessage } from '../platform-messages';
import type { ApprovalContext, WorkflowRunStatus } from '../schemas';
import {
  isApprovalContext,
  isWorkflowWaitContext,
  type BodySessionCursorAncestry,
} from '../schemas';
import type { GatePauseEventInput } from '../store';
import { WorkflowRunPauseConflictError } from '../store';
import { getLog } from './log';
import { type RunLayersContext } from './run-context';

/**
 * Send a paused run's inline notice. The durable pause is the record and the attention
 * queue is where it is answered, so a notice the platform cannot deliver leaves the run
 * paused. The failure is persisted on the run as `pause_notice_undelivered` (beside the
 * `platform_message_send_failed` log `safeSendMessage` writes), so a reader of the run
 * can see that nobody was told. It names the pause `occurrence` so the push router can
 * treat that pause as unannounced and notify the owner itself.
 */
export async function sendPauseNotice(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRunId: string,
  nodeId: string,
  occurrence: string,
  stepName: string,
  notice: string
): Promise<void> {
  if (
    await safeSendMessage(platform, conversationId, notice, {
      workflowId: workflowRunId,
      nodeName: nodeId,
    })
  )
    return;
  await deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRunId,
      event_type: 'pause_notice_undelivered',
      step_name: stepName,
      data: { nodeId, occurrence, platform: platform.getPlatformType() },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId, eventType: 'pause_notice_undelivered' },
        'workflow.event_persist_failed'
      );
    });
}

/**
 * The run's status after a pause write failed. When that read fails too the status is
 * unknowable, so the original pause failure surfaces rather than the read's error.
 */
export async function statusAfterPauseFailure(
  store: Pick<WorkflowDeps['store'], 'getWorkflowRunStatus'>,
  runId: string,
  pauseError: unknown
): Promise<WorkflowRunStatus | null> {
  try {
    return await store.getWorkflowRunStatus(runId);
  } catch (statusErr) {
    getLog().warn({ err: statusErr as Error, workflowRunId: runId }, 'dag.status_check_failed');
    throw pauseError;
  }
}

type GatePauseResult =
  | { kind: 'paused'; approval: ApprovalContext }
  | { kind: 'deferred' }
  | { kind: 'external_transition' };

/**
 * A same-run gate that loses the running-to-paused CAS stays unfinished for resume.
 * External stops retain ownership of terminal state; other store failures propagate.
 * Write-back requires a successful pause before its apply/teardown path can proceed.
 * `event` commits with the pause, so every gate pause reaches the event feed the
 * attention watch follows. Only sibling deferral leaves a resumable leaf; an
 * external terminal transition owns the run without suspending this node.
 */
export async function pauseGateRespectingExternalTransition(
  deps: WorkflowDeps,
  runId: string,
  approvalContext: ApprovalContext,
  options: {
    event: GatePauseEventInput;
    extraMetadata?: Record<string, unknown>;
    failClosed?: boolean;
  }
): Promise<GatePauseResult> {
  const { extraMetadata, failClosed = false } = options;
  approvalContext = { ...approvalContext, pauseId: randomUUID() };
  try {
    await deps.store.pauseWorkflowRun(runId, approvalContext, extraMetadata, options.event);
  } catch (pauseErr) {
    if (failClosed || !(pauseErr instanceof WorkflowRunPauseConflictError)) throw pauseErr;
    const status = await statusAfterPauseFailure(deps.store, runId, pauseErr);
    if (status === 'running' || status === 'pending') throw pauseErr;
    if (status === 'paused') {
      const run = await deps.store.getWorkflowRun(runId);
      const active = run?.metadata?.approval;
      const wait = run?.metadata?.wait;
      if (isWorkflowWaitContext(wait)) {
        getLog().info(
          { workflowRunId: runId, nodeId: approvalContext.nodeId, activeNodeId: wait.nodeId },
          'dag.gate_deferred'
        );
        return { kind: 'deferred' };
      }
      if (
        !isApprovalContext(active) ||
        (active.nodeId === approvalContext.nodeId &&
          active.bodyGateId === approvalContext.bodyGateId)
      )
        throw pauseErr;
      getLog().info(
        { workflowRunId: runId, nodeId: approvalContext.nodeId, activeNodeId: active.nodeId },
        'dag.gate_deferred'
      );
      return { kind: 'deferred' };
    }
    getLog().warn(
      { workflowRunId: runId, status, err: pauseErr as Error },
      'dag.gate_pause_skipped_external_transition'
    );
    return { kind: 'external_transition' };
  }
  getWorkflowEventEmitter().emit({
    type: 'approval_pending',
    runId,
    nodeId: approvalContext.nodeId,
    message: approvalContext.message,
    decisions: approvalContext.decisions,
    pauseId: approvalContext.pauseId,
  });
  return { kind: 'paused', approval: approvalContext };
}

export function snapshotBodySessionCursorAncestry(
  ancestry: RunLayersContext['bodySessionCursorAncestry']
): { bodySessionCursorAncestry?: BodySessionCursorAncestry } {
  return ancestry === undefined || ancestry.size === 0
    ? {}
    : {
        bodySessionCursorAncestry: Object.fromEntries(
          [...ancestry].map(([key, cursors]) => [key, Object.fromEntries(cursors)])
        ),
      };
}
