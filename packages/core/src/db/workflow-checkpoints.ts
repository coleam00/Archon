/**
 * Database operations for workflow node retry checkpoints.
 */
import { pool } from './connection';
import type { WorkflowCheckpointRow } from '../schemas/workflow-checkpoint';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflow-checkpoints');
  return cachedLog;
}

type WorkflowCheckpointDbRow = Omit<WorkflowCheckpointRow, 'created_commit'> & {
  created_commit: boolean | number;
};

export interface UpsertWorkflowNodeCheckpointInput {
  workflow_run_id: string;
  node_id: string;
  retry_epoch: number;
  checkpoint_ref: string;
  commit_sha: string;
  created_commit: boolean;
  fallback_from_node_id?: string | null;
}

export interface LatestWorkflowNodeCheckpointQuery {
  workflow_run_id: string;
  node_id: string;
  retry_epoch?: number;
}

function normalizeCheckpointRow(row: WorkflowCheckpointDbRow): WorkflowCheckpointRow {
  return {
    ...row,
    created_commit:
      typeof row.created_commit === 'number' ? row.created_commit !== 0 : row.created_commit,
  };
}

export async function upsertWorkflowNodeCheckpoint(
  input: UpsertWorkflowNodeCheckpointInput
): Promise<WorkflowCheckpointRow> {
  const result = await pool.query<WorkflowCheckpointDbRow>(
    `INSERT INTO remote_agent_workflow_node_checkpoints
       (workflow_run_id, node_id, retry_epoch, checkpoint_ref, commit_sha, created_commit, fallback_from_node_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workflow_run_id, node_id, retry_epoch)
     DO UPDATE SET
       checkpoint_ref = EXCLUDED.checkpoint_ref,
       commit_sha = EXCLUDED.commit_sha,
       created_commit = EXCLUDED.created_commit,
       fallback_from_node_id = EXCLUDED.fallback_from_node_id
     RETURNING *`,
    [
      input.workflow_run_id,
      input.node_id,
      input.retry_epoch,
      input.checkpoint_ref,
      input.commit_sha,
      input.created_commit,
      input.fallback_from_node_id ?? null,
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `Failed to upsert workflow checkpoint for ${input.workflow_run_id}/${input.node_id}@${String(
        input.retry_epoch
      )}: no row returned`
    );
  }
  return normalizeCheckpointRow(row);
}

export async function getWorkflowNodeCheckpoint(
  workflowRunId: string,
  nodeId: string,
  retryEpoch: number
): Promise<WorkflowCheckpointRow | null> {
  const result = await pool.query<WorkflowCheckpointDbRow>(
    `SELECT * FROM remote_agent_workflow_node_checkpoints
     WHERE workflow_run_id = $1 AND node_id = $2 AND retry_epoch = $3`,
    [workflowRunId, nodeId, retryEpoch]
  );
  return result.rows[0] ? normalizeCheckpointRow(result.rows[0]) : null;
}

export async function getLatestWorkflowNodeCheckpoint(
  query: LatestWorkflowNodeCheckpointQuery
): Promise<WorkflowCheckpointRow | null> {
  const params: unknown[] = [query.workflow_run_id, query.node_id];
  let epochClause = '';
  if (query.retry_epoch !== undefined) {
    params.push(query.retry_epoch);
    epochClause = ` AND retry_epoch <= $${String(params.length)}`;
  }
  const result = await pool.query<WorkflowCheckpointDbRow>(
    `SELECT * FROM remote_agent_workflow_node_checkpoints
     WHERE workflow_run_id = $1 AND node_id = $2${epochClause}
     ORDER BY retry_epoch DESC
     LIMIT 1`,
    params
  );
  return result.rows[0] ? normalizeCheckpointRow(result.rows[0]) : null;
}

export async function findLatestCheckpointForRetry(
  workflowRunId: string,
  targetNodeId: string,
  upstreamNodeIds: readonly string[],
  retryEpoch: number
): Promise<WorkflowCheckpointRow | null> {
  const target = await getLatestWorkflowNodeCheckpoint({
    workflow_run_id: workflowRunId,
    node_id: targetNodeId,
    retry_epoch: retryEpoch,
  });
  if (target) return target;

  for (const upstreamNodeId of upstreamNodeIds) {
    const fallback = await getLatestWorkflowNodeCheckpoint({
      workflow_run_id: workflowRunId,
      node_id: upstreamNodeId,
      retry_epoch: retryEpoch,
    });
    if (fallback) {
      return { ...fallback, fallback_from_node_id: fallback.node_id };
    }
  }
  return null;
}

export async function listWorkflowNodeCheckpoints(
  workflowRunId: string
): Promise<WorkflowCheckpointRow[]> {
  const result = await pool.query<WorkflowCheckpointDbRow>(
    `SELECT * FROM remote_agent_workflow_node_checkpoints
     WHERE workflow_run_id = $1
     ORDER BY retry_epoch ASC, node_id ASC`,
    [workflowRunId]
  );
  return result.rows.map(normalizeCheckpointRow);
}

export async function deleteWorkflowNodeCheckpointsForRun(
  workflowRunId: string
): Promise<{ deleted: number }> {
  try {
    const result = await pool.query(
      'DELETE FROM remote_agent_workflow_node_checkpoints WHERE workflow_run_id = $1',
      [workflowRunId]
    );
    return { deleted: result.rowCount };
  } catch (err) {
    getLog().error({ err: err as Error, workflowRunId }, 'db.workflow_checkpoints_delete_failed');
    throw err;
  }
}
