/**
 * Stopped items: the completed runs that recorded a stop in the write that completed them
 * (`item_stopped` in the run's metadata, see `itemStoppedMetadata`), read for the attention
 * queue while each is still its item's last run.
 */
import type { AttentionRead } from '@archon/workflows/schemas/attention-degraded';
import {
  ASKS_SETTLED_SOURCE_ACTOR,
  RUN_ENDED_SOURCE_ACTOR,
  sourceReceiptInputSchema,
} from '@archon/workflows/schemas/resource-start';
import {
  ITEM_STOPPED_METADATA_KEY,
  itemStoppedMetadata,
  type StoppedLimit,
  type StoppedRefusal,
} from '@archon/workflows/schemas/run-metadata';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';
import { getDatabaseType, getDialect, pool } from './connection';
import type { TransactionQuery as Query } from './resource-slots';
import { normalizeWorkflowRun, type WorkflowRunRow } from './workflow-run-normalization';
import { getLog } from './workflow-run-shared';

/**
 * The completed runs that stopped their item and are still its last run (see
 * `IWorkflowStore.listStoppedItemRuns`). Runs on an item are ordered as `getItemRuns` orders
 * them: by start time, and on SQLite, which records it to the second, by insertion order
 * within a second. Any run after this one, in any status, ends the stop, and deleting that
 * later run keeps it ended (`closeStopsBeforeRun`).
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

/**
 * Close the stops recorded before run `runId` on its item, inside the transaction that
 * deletes it. A stop is open while its run is the item's newest, so the deleted run is the
 * only evidence that the item moved on; without this, deleting it would reopen them.
 */
export async function closeStopsBeforeRun(query: Query, runId: string): Promise<void> {
  const tie = getDatabaseType() === 'sqlite' ? 'rowid' : 'id';
  await query(
    `UPDATE remote_agent_workflow_runs SET metadata = ${getDialect().jsonMerge('metadata', 2)}
      WHERE id IN (
        SELECT r.id FROM remote_agent_workflow_runs r
          JOIN remote_agent_workflow_runs d ON d.id = $1 AND d.item_id = r.item_id
         WHERE r.id <> d.id
           AND ${getDialect().jsonText('r.metadata', ITEM_STOPPED_METADATA_KEY)} IS NOT NULL
           AND (r.started_at < d.started_at
             OR (r.started_at = d.started_at AND r.${tie} < d.${tie})))`,
    [runId, JSON.stringify({ [ITEM_STOPPED_METADATA_KEY]: null })]
  );
}

/**
 * Record that a refused start stopped its item, inside the refusing transaction: on the
 * completed run whose end (a run-ended binding) or settled asks (an asks-settled binding)
 * caused the start, which is then the item's last step. Admission refuses at a start limit
 * (`limit`); preparation refuses before launch (`refused`). The attention queue lists the
 * item as `stopped` while that run is the item's newest, and any later run on the item ends
 * it. A start caused by anything else (a fire, a schedule, a node) has no such run; a start
 * on another item than the run's (a linked start) and a run with an open ask or wait on the
 * item stop nothing.
 */
export async function recordRefusedStartStop(
  query: Query,
  receiptId: string,
  itemKey: string,
  refusal: { limit: StoppedLimit } | { refused: StoppedRefusal }
): Promise<void> {
  const receipt = (
    await query<{ source_actor: unknown }>(
      'SELECT source_actor FROM remote_agent_start_receipts WHERE id = $1',
      [receiptId]
    )
  ).rows[0];
  const stored = receipt?.source_actor;
  const actor = sourceReceiptInputSchema.shape.sourceActor.safeParse(
    typeof stored === 'string' ? JSON.parse(stored) : (stored ?? null)
  );
  const source = actor.success ? actor.data : undefined;
  if (source?.source !== RUN_ENDED_SOURCE_ACTOR && source?.source !== ASKS_SETTLED_SOURCE_ACTOR)
    return;
  await query(
    `UPDATE remote_agent_workflow_runs SET metadata = ${getDialect().jsonMerge('metadata', 3)}
      WHERE id = $1 AND status = 'completed'
        AND EXISTS (SELECT 1 FROM remote_agent_items i
                     WHERE i.id = remote_agent_workflow_runs.item_id AND i.key = $2)
        AND NOT EXISTS (SELECT 1 FROM remote_agent_item_asks
                         WHERE run_id = $4 AND closed_as IS NULL)
        AND NOT EXISTS (SELECT 1 FROM remote_agent_item_waits
                         WHERE run_id = $4 AND closed_as IS NULL)`,
    // The run id twice: the runs table keys it as a UUID on PostgreSQL, asks and waits as text.
    [source.id, itemKey, JSON.stringify(itemStoppedMetadata(null, refusal)), source.id]
  );
}

/**
 * Record the stops of the bindings `receipts` refused at the hand-off (`refused` on their
 * evaluated bindings), inside the transaction that writes them. On a run's completion call
 * it after the run's asks and waits are opened: a run that leaves one stops nothing.
 */
export async function recordRefusedHandoffStops(
  query: Query,
  receipts: readonly SourceReceiptAcceptance[]
): Promise<void> {
  for (const { receipt, evaluatedBindings } of receipts) {
    const { id: receiptId, itemKey, receivedAt } = receipt;
    if (itemKey === undefined) continue;
    for (const { bindingId, refused } of evaluatedBindings ?? [])
      if (refused !== undefined)
        await recordRefusedStartStop(query, receiptId, itemKey, {
          refused: { receiptId, bindingId, ...refused, refusedAt: receivedAt },
        });
  }
}
