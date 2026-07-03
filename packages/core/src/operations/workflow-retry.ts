/**
 * Shared manual workflow-node retry operation primitives.
 */
import { getDialect, pool } from '../db/connection';
import * as workflowDb from '../db/workflows';
import * as workflowEventDb from '../db/workflow-events';
import * as workflowNodeSessionDb from '../db/workflow-node-sessions';
import * as workflowCheckpointDb from '../db/workflow-checkpoints';
import { createRetrySafetyRef, resetTrackedFilesToCommit, verifyCommitRef } from '@archon/git';
import {
  nodeRetryFailedEventDataSchema,
  nodeRetryRequestedEventDataSchema,
  nodeRetryResetEventDataSchema,
  type NodeRetryFailedEventData,
  type NodeRetryRequestedEventData,
  type NodeRetryResetEventData,
} from '../schemas/workflow-event';
import {
  getRetryInvalidatedNodeIds,
  projectLatestEffectiveNodeStates,
} from '@archon/workflows/retry-state';
import { isRouteLoopNode } from '@archon/workflows/schemas/dag-node';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { RETRYABLE_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';

export type WorkflowRetryRequesterSurface = 'web' | 'cli';

export type WorkflowRetryErrorCode =
  | 'run_not_found'
  | 'run_not_retryable'
  | 'node_not_found'
  | 'node_not_failed'
  | 'node_not_retryable'
  | 'cas_miss'
  | 'path_in_use'
  | 'checkpoint_unavailable'
  | 'git_reset_failed'
  | 'dispatch_failed';

export interface WorkflowNodeRetryRequest {
  runId: string;
  nodeId: string;
  requesterSurface: WorkflowRetryRequesterSurface;
  requesterUserId: string;
  authorizationBasis: string;
}

export interface PrepareWorkflowNodeRetryInput extends WorkflowNodeRetryRequest {
  workflow: WorkflowDefinition;
}

export interface WorkflowNodeRetryPreparedResult {
  runId: string;
  workflowName: string;
  preCreatedRun: WorkflowRun;
  retryEpoch: number;
  invalidatedNodeIds: string[];
  preservedCompletedOutputs: Map<string, string>;
  resetSkipped: boolean;
  safetyRef?: string;
  safetyCommitSha?: string;
  checkpointRef?: string;
  checkpointCommitSha?: string;
}

export class WorkflowRetryError extends Error {
  constructor(
    readonly code: WorkflowRetryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'WorkflowRetryError';
  }
}

export type RetryAuditEvent =
  | { eventType: 'node_retry_requested'; data: NodeRetryRequestedEventData }
  | { eventType: 'node_retry_reset'; data: NodeRetryResetEventData }
  | { eventType: 'node_retry_failed'; data: NodeRetryFailedEventData };

function getMetadataRetryEpoch(metadata: Record<string, unknown>): number {
  const value = metadata.retry_epoch;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

async function restoreFailedAfterRetrySetupError(
  runId: string,
  nodeId: string,
  retryEpoch: number,
  error: Error,
  setupPhase: string
): Promise<void> {
  await writeRetryAuditEvent(runId, {
    eventType: 'node_retry_failed',
    data: {
      node_id: nodeId,
      retry_epoch: retryEpoch,
      setup_phase: setupPhase,
      error: error.message,
    },
  }).catch(() => undefined);

  await workflowDb
    .updateWorkflowRun(runId, {
      status: 'failed',
      metadata: { retry_setup_error: error.message },
    })
    .catch(() => undefined);
}

function toRetryError(
  error: unknown,
  fallbackCode: WorkflowRetryErrorCode = 'dispatch_failed'
): WorkflowRetryError {
  if (error instanceof WorkflowRetryError) return error;
  if (error instanceof workflowDb.WorkflowRetryNotClaimableError) {
    return new WorkflowRetryError('cas_miss', error.message);
  }
  const err = error as Error;
  return new WorkflowRetryError(fallbackCode, err.message);
}

function requireWorkflowRunPath(run: WorkflowRun): string {
  if (!run.working_path) {
    throw new WorkflowRetryError(
      'git_reset_failed',
      `Cannot prepare retry reset for workflow run ${run.id}: missing working_path`
    );
  }
  return run.working_path;
}

function getRunStartedAtDate(run: WorkflowRun): Date {
  return run.started_at instanceof Date ? run.started_at : new Date(run.started_at);
}

function buildPathInUseError(claimedRun: WorkflowRun, activeRun: WorkflowRun): WorkflowRetryError {
  const shortActiveRunId = activeRun.id.slice(0, 8);
  return new WorkflowRetryError(
    'path_in_use',
    `Cannot retry workflow run ${claimedRun.id}: working path is in use by workflow '${activeRun.workflow_name}' (${activeRun.status}, run ${shortActiveRunId})`
  );
}

export async function prepareWorkflowNodeRetry(
  input: PrepareWorkflowNodeRetryInput
): Promise<WorkflowNodeRetryPreparedResult> {
  const run = await workflowDb.getWorkflowRun(input.runId);
  if (!run) {
    throw new WorkflowRetryError('run_not_found', `Workflow run not found: ${input.runId}`);
  }
  if (!RETRYABLE_WORKFLOW_STATUSES.includes(run.status)) {
    throw new WorkflowRetryError(
      'run_not_retryable',
      `Cannot retry workflow run ${input.runId} with status '${run.status}'. Only failed or cancelled runs can be retried.`
    );
  }

  const targetNode = input.workflow.nodes.find(node => node.id === input.nodeId);
  if (!targetNode) {
    throw new WorkflowRetryError(
      'node_not_found',
      `Retry target node '${input.nodeId}' is not present in workflow '${input.workflow.name}'`
    );
  }
  if (isRouteLoopNode(targetNode)) {
    throw new WorkflowRetryError(
      'node_not_retryable',
      `Cannot retry route_loop controller node '${input.nodeId}' directly; retry its source node '${targetNode.route_loop.from}' instead`
    );
  }

  const events = await workflowEventDb.listWorkflowEvents(input.runId);
  const latestNodeState = projectLatestEffectiveNodeStates(events).get(input.nodeId);
  const cancelledRunInterruptedTarget =
    run.status === 'cancelled' && latestNodeState?.state === 'running';
  if (latestNodeState?.state !== 'failed' && !cancelledRunInterruptedTarget) {
    throw new WorkflowRetryError(
      'node_not_failed',
      `Cannot retry node '${input.nodeId}' because its latest effective status is '${latestNodeState?.state ?? 'unknown'}'`
    );
  }

  const invalidatedNodeIds = getRetryInvalidatedNodeIds(input.workflow.nodes, input.nodeId);
  let claimedRun: WorkflowRun | undefined;
  let retryEpoch = 0;
  let setupPhase = 'retry_preparation';

  try {
    claimedRun = await workflowDb.claimWorkflowRunForNodeRetry(input.runId);
    retryEpoch = getMetadataRetryEpoch(claimedRun.metadata);

    await writeRetryAuditEvent(input.runId, {
      eventType: 'node_retry_requested',
      data: {
        runId: input.runId,
        node_id: input.nodeId,
        retry_epoch: retryEpoch,
        invalidated_node_ids: invalidatedNodeIds,
        requester_surface: input.requesterSurface,
        requester_user_id: input.requesterUserId,
        authorization_basis: input.authorizationBasis,
      },
    });

    let resetSkipped = true;
    let safetyRef: string | undefined;
    let safetyCommitSha: string | undefined;
    let checkpointRef: string | undefined;
    let checkpointCommitSha: string | undefined;

    if (input.workflow.mutates_checkout === false) {
      await writeRetryAuditEvent(input.runId, {
        eventType: 'node_retry_reset',
        data: {
          node_id: input.nodeId,
          retry_epoch: retryEpoch,
          checkpoint_ref: null,
          checkpoint_commit_sha: null,
          safety_ref: null,
          safety_commit_sha: null,
          reset_skipped: true,
        },
      });
    } else {
      const repoPath = requireWorkflowRunPath(claimedRun);
      setupPhase = 'path_lock';
      const activeWorkflow = await workflowDb.getActiveWorkflowRunByPath(repoPath, {
        id: claimedRun.id,
        startedAt: getRunStartedAtDate(claimedRun),
      });
      if (activeWorkflow) {
        throw buildPathInUseError(claimedRun, activeWorkflow);
      }

      setupPhase = 'checkpoint_lookup';
      const checkpoint = await workflowCheckpointDb.findLatestCheckpointForRetry(
        input.runId,
        input.nodeId,
        targetNode.depends_on ?? [],
        retryEpoch
      );

      if (!checkpoint) {
        setupPhase = 'checkpoint_validation';
        try {
          checkpointCommitSha = await verifyCommitRef(repoPath, 'HEAD');
        } catch (error) {
          throw toRetryError(error, 'checkpoint_unavailable');
        }

        setupPhase = 'safety_ref';
        let safety;
        try {
          safety = await createRetrySafetyRef(repoPath, {
            runId: input.runId,
            retryEpoch,
            workflowName: run.workflow_name,
            nodeId: input.nodeId,
          });
        } catch (error) {
          throw toRetryError(error, 'git_reset_failed');
        }
        safetyRef = safety.ref;
        safetyCommitSha = safety.commitSha;

        setupPhase = 'git_reset';
        try {
          checkpointCommitSha = await resetTrackedFilesToCommit(repoPath, checkpointCommitSha);
        } catch (error) {
          throw toRetryError(error, 'git_reset_failed');
        }

        resetSkipped = false;
        setupPhase = 'retry_preparation';
        await writeRetryAuditEvent(input.runId, {
          eventType: 'node_retry_reset',
          data: {
            node_id: input.nodeId,
            retry_epoch: retryEpoch,
            checkpoint_ref: null,
            checkpoint_commit_sha: checkpointCommitSha,
            safety_ref: safetyRef,
            safety_commit_sha: safetyCommitSha,
            reset_skipped: false,
          },
        });
      } else {
        checkpointRef = checkpoint.checkpoint_ref;

        setupPhase = 'checkpoint_validation';
        try {
          checkpointCommitSha = await verifyCommitRef(repoPath, checkpoint.checkpoint_ref);
        } catch (error) {
          throw toRetryError(error, 'checkpoint_unavailable');
        }

        setupPhase = 'safety_ref';
        let safety;
        try {
          safety = await createRetrySafetyRef(repoPath, {
            runId: input.runId,
            retryEpoch,
            workflowName: run.workflow_name,
            nodeId: input.nodeId,
          });
        } catch (error) {
          throw toRetryError(error, 'git_reset_failed');
        }
        safetyRef = safety.ref;
        safetyCommitSha = safety.commitSha;

        setupPhase = 'git_reset';
        try {
          checkpointCommitSha = await resetTrackedFilesToCommit(
            repoPath,
            checkpoint.checkpoint_ref
          );
        } catch (error) {
          throw toRetryError(error, 'git_reset_failed');
        }

        resetSkipped = false;
        setupPhase = 'retry_preparation';
        await writeRetryAuditEvent(input.runId, {
          eventType: 'node_retry_reset',
          data: {
            node_id: input.nodeId,
            retry_epoch: retryEpoch,
            checkpoint_ref: checkpointRef,
            checkpoint_commit_sha: checkpointCommitSha,
            safety_ref: safetyRef,
            safety_commit_sha: safetyCommitSha,
            reset_skipped: false,
          },
        });
      }
    }

    const preservedCompletedOutputs = await workflowEventDb.getRetryPreservedDagNodeOutputs(
      input.runId,
      invalidatedNodeIds
    );

    await Promise.all(
      invalidatedNodeIds.map(nodeId =>
        workflowNodeSessionDb.deleteWorkflowNodeSessions({
          workflow_name: run.workflow_name,
          scope_key: run.conversation_id,
          node_id: nodeId,
        })
      )
    );

    return {
      runId: input.runId,
      workflowName: run.workflow_name,
      preCreatedRun: claimedRun,
      retryEpoch,
      invalidatedNodeIds,
      preservedCompletedOutputs,
      resetSkipped,
      safetyRef,
      safetyCommitSha,
      checkpointRef,
      checkpointCommitSha,
    };
  } catch (error) {
    const retryError = toRetryError(error);
    if (claimedRun) {
      await restoreFailedAfterRetrySetupError(
        input.runId,
        input.nodeId,
        retryEpoch,
        retryError,
        setupPhase
      );
    }
    throw retryError;
  }
}

export async function writeRetryAuditEvent(
  workflowRunId: string,
  event: RetryAuditEvent
): Promise<void> {
  const parsed =
    event.eventType === 'node_retry_requested'
      ? nodeRetryRequestedEventDataSchema.parse(event.data)
      : event.eventType === 'node_retry_reset'
        ? nodeRetryResetEventDataSchema.parse(event.data)
        : nodeRetryFailedEventDataSchema.parse(event.data);
  const dialect = getDialect();
  await pool.query(
    `INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type, step_index, step_name, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      dialect.generateUuid(),
      workflowRunId,
      event.eventType,
      null,
      parsed.node_id,
      JSON.stringify(parsed),
    ]
  );
}
