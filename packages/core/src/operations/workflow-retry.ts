/**
 * Shared manual workflow-node retry operation primitives.
 */
import { getDialect, pool } from '../db/connection';
import * as workflowDb from '../db/workflows';
import * as workflowEventDb from '../db/workflow-events';
import * as workflowNodeSessionDb from '../db/workflow-node-sessions';
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
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

export type WorkflowRetryRequesterSurface = 'web' | 'cli';

export type WorkflowRetryErrorCode =
  | 'run_not_found'
  | 'run_not_failed'
  | 'node_not_found'
  | 'node_not_failed'
  | 'cas_miss'
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

function toRetryError(error: unknown): WorkflowRetryError {
  if (error instanceof WorkflowRetryError) return error;
  if (error instanceof workflowDb.WorkflowRetryNotClaimableError) {
    return new WorkflowRetryError('cas_miss', error.message);
  }
  const err = error as Error;
  return new WorkflowRetryError('dispatch_failed', err.message);
}

export async function prepareWorkflowNodeRetry(
  input: PrepareWorkflowNodeRetryInput
): Promise<WorkflowNodeRetryPreparedResult> {
  const run = await workflowDb.getWorkflowRun(input.runId);
  if (!run) {
    throw new WorkflowRetryError('run_not_found', `Workflow run not found: ${input.runId}`);
  }
  if (run.status !== 'failed') {
    throw new WorkflowRetryError(
      'run_not_failed',
      `Cannot retry workflow run ${input.runId} with status '${run.status}'`
    );
  }

  const targetNode = input.workflow.nodes.find(node => node.id === input.nodeId);
  if (!targetNode) {
    throw new WorkflowRetryError(
      'node_not_found',
      `Retry target node '${input.nodeId}' is not present in workflow '${input.workflow.name}'`
    );
  }

  if (input.workflow.mutates_checkout !== false) {
    throw new WorkflowRetryError(
      'checkpoint_unavailable',
      'Manual retry for mutating workflows requires checkpoint reset support; set mutates_checkout: false for no-reset retry paths.'
    );
  }

  const events = await workflowEventDb.listWorkflowEvents(input.runId);
  const latestNodeState = projectLatestEffectiveNodeStates(events).get(input.nodeId);
  if (latestNodeState?.state !== 'failed') {
    throw new WorkflowRetryError(
      'node_not_failed',
      `Cannot retry node '${input.nodeId}' because its latest effective status is '${latestNodeState?.state ?? 'unknown'}'`
    );
  }

  const invalidatedNodeIds = getRetryInvalidatedNodeIds(input.workflow.nodes, input.nodeId);
  let claimedRun: WorkflowRun | undefined;
  let retryEpoch = 0;

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
      resetSkipped: true,
    };
  } catch (error) {
    const retryError = toRetryError(error);
    if (claimedRun) {
      await restoreFailedAfterRetrySetupError(
        input.runId,
        input.nodeId,
        retryEpoch,
        retryError,
        'retry_preparation'
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
