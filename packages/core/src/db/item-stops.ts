/**
 * Stopped items: the completed runs that recorded a stop in the write that completed them
 * (`item_stopped` in the run's metadata, see `itemStoppedMetadata`), read for the attention
 * queue while each is still its item's last run.
 */
import type { AttentionRead } from '@archon/workflows/schemas/attention-degraded';
import { ITEM_STOPPED_METADATA_KEY } from '@archon/workflows/schemas/run-metadata';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { getDatabaseType, getDialect, pool } from './connection';
import { normalizeWorkflowRun, type WorkflowRunRow } from './workflow-run-normalization';
import { getLog } from './workflow-run-shared';

/**
 * The completed runs that stopped their item and are still its last run (see
 * `IWorkflowStore.listStoppedItemRuns`). Runs on an item are ordered as `getItemRuns` orders
 * them: by start time, and on SQLite, which records it to the second, by insertion order
 * within a second. Any run after this one, in any status, ends the stop.
 */
export async function listStoppedItemRuns(): Promise<AttentionRead<WorkflowRun>[]> {
  const tie = getDatabaseType() === 'sqlite' ? 'rowid' : 'id';
  const result = await pool.query<WorkflowRunRow>(
    `SELECT r.*, CAST(r.origin AS TEXT) AS origin
     FROM remote_agent_workflow_runs r
     WHERE r.status = 'completed' AND r.item_id IS NOT NULL
       AND ${getDialect().jsonText('r.metadata', ITEM_STOPPED_METADATA_KEY)} IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM remote_agent_workflow_runs n
         WHERE n.item_id = r.item_id AND n.id <> r.id
           AND (n.started_at > r.started_at
             OR (n.started_at = r.started_at AND n.${tie} > r.${tie}))
       )
     ORDER BY r.started_at, r.${tie}`
  );
  const runs: AttentionRead<WorkflowRun>[] = [];
  for (const row of result.rows) {
    try {
      runs.push(normalizeWorkflowRun(row));
    } catch {
      // Parser errors can quote stored data, including message text.
      getLog().error({ workflowRunId: row.id }, 'attention_run_normalization_failed');
      runs.push({ type: 'degraded', reason: 'run_unreadable', runId: row.id });
    }
  }
  return runs;
}
