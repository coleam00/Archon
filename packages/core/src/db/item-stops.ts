/**
 * Stopped items: the completed runs that recorded a stop in the write that completed them
 * (`item_stopped` in the run's metadata, see `itemStoppedMetadata`), read for the attention
 * queue while each is still its item's last run.
 */
import type { AttentionRead } from '@archon/workflows/schemas/attention-degraded';
import { ITEM_STOPPED_METADATA_KEY } from '@archon/workflows/schemas/run-metadata';
import {
  TERMINAL_WORKFLOW_STATUSES,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { getDialect, pool } from './connection';
import { normalizeWorkflowRun, type WorkflowRunRow } from './workflow-run-normalization';
import { getLog } from './workflow-run-shared';

/**
 * The completed runs that stopped their item and are still its last run (see
 * `IWorkflowStore.listStoppedItemRuns`). Another run on the item ends the stop when it is
 * not terminal (pending, running or paused, so the item is moving) or ended after this
 * one. End time, not start time, orders terminal runs: SQLite keeps both to the second,
 * and a run that started earlier but ended later is the item's last. The id breaks a tie,
 * so of two runs that ended in one second exactly one is the last.
 */
export async function listStoppedItemRuns(): Promise<AttentionRead<WorkflowRun>[]> {
  const terminal = TERMINAL_WORKFLOW_STATUSES.map((_, i) => `$${String(i + 1)}`).join(', ');
  const result = await pool.query<WorkflowRunRow>(
    `SELECT r.*, CAST(r.origin AS TEXT) AS origin
     FROM remote_agent_workflow_runs r
     WHERE r.status = 'completed' AND r.item_id IS NOT NULL
       AND ${getDialect().jsonText('r.metadata', ITEM_STOPPED_METADATA_KEY)} IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM remote_agent_workflow_runs n
         WHERE n.item_id = r.item_id AND n.id <> r.id
           AND (n.status NOT IN (${terminal})
             OR n.completed_at > r.completed_at
             OR (n.completed_at = r.completed_at AND n.id > r.id))
       )
     ORDER BY r.completed_at, r.id`,
    [...TERMINAL_WORKFLOW_STATUSES]
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
