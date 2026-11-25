/**
 * The top-level runs that need an owner to move, read for the attention queue's `owner_lost`
 * items (see `IWorkflowStore.listUnfinishedRuns`).
 */
import type { AttentionRead } from '@archon/workflows/schemas/attention-degraded';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { pool } from './connection';
import { normalizeWorkflowRun, type WorkflowRunRow } from './workflow-run-normalization';
import { getLog } from './workflow-run-shared';

/** Top-level `pending`, `running` or `paused` runs, on any item or none, oldest first. */
export async function listUnfinishedRuns(): Promise<AttentionRead<WorkflowRun>[]> {
  const result = await pool.query<WorkflowRunRow>(
    `SELECT r.*, CAST(r.origin AS TEXT) AS origin
     FROM remote_agent_workflow_runs r
     WHERE r.parent_run_id IS NULL AND r.status IN ('pending', 'running', 'paused')
     ORDER BY r.started_at, r.id`
  );
  const runs: AttentionRead<WorkflowRun>[] = [];
  for (const row of result.rows) {
    try {
      runs.push(normalizeWorkflowRun(row));
    } catch {
      // Parser errors can quote stored data, including message text.
      getLog().error({ workflowRunId: row.id }, 'attention_run_normalization_failed');
      runs.push({ type: 'degraded', reason: 'run_unreadable', runId: String(row.id) });
    }
  }
  return runs;
}
