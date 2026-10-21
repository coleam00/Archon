import type { NodeExecutionResult } from '../node-record-serialization';
import { randomUUID } from 'node:crypto';
import type { IWorkflowPlatform, WorkflowDeps } from '../deps';
import { getWorkflowEventEmitter } from '../event-emitter';
import { safeSendMessage } from '../platform-messages';
import type { ApprovalContext, WorkflowWaitContext, WorkflowRunStatus } from '../schemas';
import {
  isApprovalContext,
  isWorkflowWaitContext,
  type BodySessionCursorAncestry,
} from '../schemas';
import type { GatePauseEventInput } from '../store';
import { WorkflowRunPauseConflictError } from '../store';
import { getLog } from './log';
import { type RunLayersContext } from './run-context';

export interface ContainerPauseReceipt {
  kind: 'container_pause';
  pause:
    | { kind: 'gate'; context: ApprovalContext }
    | { kind: 'wait'; context: WorkflowWaitContext };
  postPublicationError?: { cause: unknown };
}

/** Shared by one DAG pass and its nested bodies; never persisted. */
export interface ContainerPauseBoundary {
  publish?: () => Promise<NodeExecutionResult>;
  receipt?: ContainerPauseReceipt;
}

/**
 * Container peers must settle before stopping. Keep one publication: its successor
 * can resume immediately, so no second candidate may publish from this execution.
 */
export async function runOrStagePause<T extends NodeExecutionResult>(
  ctx: RunLayersContext,
  publish: () => Promise<T>,
  deferred: (selected: boolean) => T | Promise<T>
): Promise<T> {
  const boundary = ctx.containerPause;
  if (boundary === undefined) return publish();
  const selected = boundary.publish === undefined;
  if (selected) boundary.publish = publish;
  return deferred(selected);
}

export async function publishContainerPause(
  boundary: ContainerPauseBoundary,
  publish: () => Promise<unknown>,
  afterPublication?: () => Promise<void>
): Promise<ContainerPauseReceipt | undefined> {
  try {
    await publish();
  } catch (cause) {
    if (boundary.receipt === undefined) throw cause;
    boundary.receipt.postPublicationError = { cause };
  }
  if (boundary.receipt !== undefined && afterPublication !== undefined) {
    try {
      await afterPublication();
    } catch (cause) {
      boundary.receipt.postPublicationError ??= { cause };
    }
  }
  return boundary.receipt;
}

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

/**
 * A same-run gate that loses the running-to-paused CAS stays unfinished for resume.
 * External stops retain ownership of terminal state; other store failures propagate.
 * Write-back requires a successful pause before its apply/teardown path can proceed.
 * `event` commits with the pause, so every gate pause reaches the event feed the
 * attention watch follows. Returns the persisted context, including its minted
 * `pauseId`; undefined when the gate did not pause.
 */
export async function pauseGateRespectingExternalTransition(
  deps: WorkflowDeps,
  runId: string,
  approvalContext: ApprovalContext,
  options: {
    event: GatePauseEventInput;
    extraMetadata?: Record<string, unknown>;
    failClosed?: boolean;
    boundary?: ContainerPauseBoundary;
  }
): Promise<ApprovalContext | undefined> {
  const { extraMetadata, failClosed = false } = options;
  approvalContext = { ...approvalContext, pauseId: randomUUID() };
  try {
    await deps.store.pauseWorkflowRun(runId, approvalContext, extraMetadata, options.event);
  } catch (pauseErr) {
    if (failClosed || !(pauseErr instanceof WorkflowRunPauseConflictError)) throw pauseErr;
    return recoverGatePauseConflict(deps, runId, approvalContext, pauseErr);
  }
  if (options.boundary !== undefined) {
    options.boundary.receipt = {
      kind: 'container_pause',
      pause: { kind: 'gate', context: approvalContext },
    };
  }
  getWorkflowEventEmitter().emit({
    type: 'approval_pending',
    runId,
    nodeId: approvalContext.nodeId,
    message: approvalContext.message,
    decisions: approvalContext.decisions,
    pauseId: approvalContext.pauseId,
  });
  return approvalContext;
}

async function recoverGatePauseConflict(
  deps: WorkflowDeps,
  runId: string,
  approvalContext: ApprovalContext,
  pauseErr: WorkflowRunPauseConflictError
): Promise<undefined> {
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
      return undefined;
    }
    if (
      !isApprovalContext(active) ||
      (active.nodeId === approvalContext.nodeId && active.bodyGateId === approvalContext.bodyGateId)
    )
      throw pauseErr;
    getLog().info(
      { workflowRunId: runId, nodeId: approvalContext.nodeId, activeNodeId: active.nodeId },
      'dag.gate_deferred'
    );
    return undefined;
  }
  getLog().warn(
    { workflowRunId: runId, status, err: pauseErr as Error },
    'dag.gate_pause_skipped_external_transition'
  );
  return undefined;
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
