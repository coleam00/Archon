/**
 * Stopped items: the completed runs that recorded a stop in the write that completed them
 * (`item_stopped` in the run's metadata, see `itemStoppedMetadata`), and the failed top-level
 * runs, read for the attention queue while each is still its item's last run.
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
  readItemStopped,
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
 * The runs that stopped their item and are still its last run (see
 * `IWorkflowStore.listStoppedItemRuns`): a completed run that recorded a stop, or a failed
 * top-level run with no scheduled resume, which nothing moves on by itself. Runs on an item are ordered as `getItemRuns` orders
 * them: by start time, and on SQLite, which records it to the second, by insertion order
 * within a second. Any run after this one, in any status, ends the stop. A run that still
 * has an open ask or wait is not listed: the ask or wait is what needs someone, and the stop
 * shows once they close.
 */
export async function listStoppedItemRuns(): Promise<AttentionRead<WorkflowRun>[]> {
  const tie = getDatabaseType() === 'sqlite' ? 'rowid' : 'id';
  const result = await pool.query<WorkflowRunRow>(
    `SELECT r.*, CAST(r.origin AS TEXT) AS origin
     FROM remote_agent_workflow_runs r
     WHERE r.item_id IS NOT NULL
       AND ((r.status = 'completed'
             AND ${getDialect().jsonText('r.metadata', ITEM_STOPPED_METADATA_KEY)} IS NOT NULL)
         OR (r.status = 'failed' AND r.parent_run_id IS NULL
             -- A failed run with a scheduled resume is due to move on by itself.
             AND ${getDialect().jsonText('r.metadata', 'scheduled_resume.resumeAt')} IS NULL))
       AND NOT EXISTS (
         SELECT 1 FROM remote_agent_workflow_runs n
         WHERE n.item_id = r.item_id AND n.id <> r.id
           AND (n.started_at > r.started_at
             OR (n.started_at = r.started_at AND n.${tie} > r.${tie}))
       )
       AND NOT EXISTS (SELECT 1 FROM remote_agent_item_asks
                        WHERE run_id = CAST(r.id AS TEXT) AND closed_as IS NULL)
       AND NOT EXISTS (SELECT 1 FROM remote_agent_item_waits
                        WHERE run_id = CAST(r.id AS TEXT) AND closed_as IS NULL)
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
 * Record that a refused start stopped its item, inside the refusing transaction: on the
 * completed run whose end (a run-ended binding) or settled asks (an asks-settled binding)
 * caused the start. A start caused by anything else (a fire, a schedule, a node) has no
 * such run. Admission refuses at a start limit (`limit`), which stops the item only when the
 * start was on the run's own item (`itemKey`, not a linked start) and the run left no open
 * ask or wait: then it is the item's last step. A start refused before launch (`refused`)
 * is always recorded, so the causing run says what it failed to start; whether the item
 * needs someone is `listStoppedItemRuns`'s to decide.
 */
export async function recordRefusedStartStop(
  query: Query,
  receiptId: string,
  refusal: { limit: StoppedLimit; itemKey: string } | { refused: StoppedRefusal }
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
  // Locked, so a sibling binding's refusal in another transaction adds to this stop rather
  // than replacing it: a limit and the preparation refusals of one run's end are kept together.
  const limited =
    'limit' in refusal
      ? `AND EXISTS (SELECT 1 FROM remote_agent_items i
                      WHERE i.id = remote_agent_workflow_runs.item_id AND i.key = $2)
         AND NOT EXISTS (SELECT 1 FROM remote_agent_item_asks
                          WHERE run_id = $3 AND closed_as IS NULL)
         AND NOT EXISTS (SELECT 1 FROM remote_agent_item_waits
                          WHERE run_id = $3 AND closed_as IS NULL)`
      : '';
  const run = (
    await query<{ metadata: unknown }>(
      `SELECT metadata FROM remote_agent_workflow_runs
        WHERE id = $1 AND status = 'completed' AND item_id IS NOT NULL
          ${limited}${getDialect().rowLock()}`,
      // The run id twice: the runs table keys it as a UUID on PostgreSQL, asks and waits as text.
      'limit' in refusal ? [source.id, refusal.itemKey, source.id] : [source.id]
    )
  ).rows[0];
  if (run === undefined) return;
  await query(
    `UPDATE remote_agent_workflow_runs SET metadata = ${getDialect().jsonMerge('metadata', 2)} WHERE id = $1`,
    [source.id, JSON.stringify(withRefusal(run.metadata, refusal))]
  );
}

/** The run's stop with `refusal` added: a limit replaces the limit, a refusal is appended. */
function withRefusal(
  metadata: unknown,
  refusal: { limit: StoppedLimit } | { refused: StoppedRefusal }
): Record<string, unknown> {
  const stored = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
  const { summary, ...prior } = readItemStopped((stored ?? {}) as Record<string, unknown>) ?? {
    summary: null,
  };
  return itemStoppedMetadata(
    summary,
    'limit' in refusal
      ? { ...prior, limit: refusal.limit }
      : { ...prior, refused: [...(prior.refused ?? []), refusal.refused] }
  );
}

/**
 * Record the stops of the bindings `receipts` refused at the hand-off (`refused` on their
 * evaluated bindings), inside the transaction that writes them.
 */
export async function recordRefusedHandoffStops(
  query: Query,
  receipts: readonly SourceReceiptAcceptance[]
): Promise<void> {
  for (const { receipt, evaluatedBindings } of receipts) {
    const { id: receiptId, receivedAt } = receipt;
    for (const { bindingId, refused } of evaluatedBindings ?? [])
      if (refused !== undefined)
        await recordRefusedStartStop(query, receiptId, {
          refused: { receiptId, bindingId, ...refused, refusedAt: receivedAt },
        });
  }
}
