/**
 * Shared manual workflow-node retry operation primitives.
 */
import { getDialect, pool } from '../db/connection';
import {
  nodeRetryFailedEventDataSchema,
  nodeRetryRequestedEventDataSchema,
  nodeRetryResetEventDataSchema,
  type NodeRetryFailedEventData,
  type NodeRetryRequestedEventData,
  type NodeRetryResetEventData,
} from '../schemas/workflow-event';

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

export interface WorkflowNodeRetryPreparedResult {
  runId: string;
  workflowName: string;
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
