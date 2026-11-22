/**
 * Row writes on workflow runs that are not lifecycle transitions: partial
 * updates, activity stamps, the checkout baseline, tool-call attention, the
 * write-back claim, and deleting terminal runs. Re-exported from the
 * `./workflows` entry.
 */

import { mutableRunMetadata } from '@archon/workflows/schemas/run-metadata';
import { getWorkflowEventEmitter } from '@archon/workflows/event-emitter';
import type { CheckoutObservation } from '@archon/workflows/schemas/checkout-observation';
import {
  TERMINAL_WORKFLOW_STATUSES,
  TOOL_CALL_ATTENTION_METADATA_KEY,
  toolCallAttentionArraySchema,
  validateWorkflowWaitMetadata,
  type ToolCallAttention,
  type WorkflowRun,
  type WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';
import { WorkflowRunDeleteRefusedError, liveDescendantsRefusal } from '@archon/workflows/store';
import { getDatabase, getDatabaseType, getDialect, pool } from './connection';
import type { TransactionQuery } from './resource-slots';
import { insertWorkflowEvent } from './workflow-events';
import { getWorkflowRun } from './workflow-run-reads';
import { getLog, lockedRunRow, normalizeMetadata } from './workflow-run-shared';

/**
 * Write-once run checkout baseline (#3305). The `IS NULL` guard makes the first value
 * permanent in the store itself, so a retried or concurrent writer can never replace the
 * observation the run actually started from; every caller gets the persisted value back.
 */
export async function recordWorkflowRunCheckoutBaseline(
  id: string,
  baseline: CheckoutObservation
): Promise<CheckoutObservation> {
  await pool.query(
    `UPDATE remote_agent_workflow_runs SET checkout_baseline = $1
      WHERE id = $2 AND checkout_baseline IS NULL`,
    [JSON.stringify(baseline), id]
  );
  const run = await getWorkflowRun(id);
  if (!run) throw new Error(`Workflow run not found (id: ${id})`);
  if (run.checkout_baseline === null) {
    throw new Error(`Workflow run ${id} has no readable checkout baseline after recording one`);
  }
  return run.checkout_baseline;
}

export async function setToolCallAttention(
  runId: string,
  streamId: string,
  calls: ToolCallAttention[]
): Promise<boolean> {
  const snapshot = toolCallAttentionArraySchema.parse(calls);
  if (snapshot.some(call => call.streamId !== streamId))
    throw new Error('Tool attention stream mismatch');
  const dialect = getDialect();
  const changed = await getDatabase().withTransaction(async query => {
    const row = await lockedRunRow(query, runId);
    if (row?.status !== 'running') return false;
    const metadata = normalizeMetadata(row.metadata);
    const previous = toolCallAttentionArraySchema.parse(
      metadata[TOOL_CALL_ATTENTION_METADATA_KEY] ?? []
    );
    const own = previous.filter(call => call.streamId === streamId);
    if (JSON.stringify(own) === JSON.stringify(snapshot)) return false;
    const combined = [...previous.filter(call => call.streamId !== streamId), ...snapshot];
    await query(
      `UPDATE remote_agent_workflow_runs SET metadata = ${dialect.jsonMerge('metadata', 2)} WHERE id = $1`,
      [
        runId,
        JSON.stringify({ [TOOL_CALL_ATTENTION_METADATA_KEY]: combined.length ? combined : null }),
      ]
    );
    await insertWorkflowEvent(query, {
      workflow_run_id: runId,
      event_type: 'run_attention_changed',
      data: { streamId, hasAttention: snapshot.length > 0 },
    });
    return true;
  });
  if (changed)
    getWorkflowEventEmitter().emit({
      type: 'run_attention_changed',
      runId,
      streamId,
      hasAttention: snapshot.length > 0,
    });
  return changed;
}

/**
 * Partially update non-terminal workflow state. Terminal transitions use their
 * dedicated lifecycle writers so the run row cannot outpace its durable event.
 */
export async function updateWorkflowRun(
  id: string,
  updates: Partial<Pick<WorkflowRun, 'metadata' | 'output_root'>> & {
    status?: Exclude<WorkflowRunStatus, 'completed' | 'failed' | 'cancelled'>;
    working_path?: string;
  }
): Promise<void> {
  const dialect = getDialect();
  const setClauses: string[] = [];
  const values: unknown[] = [];
  const requestedStatus: WorkflowRunStatus | undefined = updates.status;
  validateWorkflowWaitMetadata(updates.metadata);

  if (requestedStatus !== undefined && TERMINAL_WORKFLOW_STATUSES.includes(requestedStatus)) {
    throw new Error(`Terminal workflow status '${requestedStatus}' requires a lifecycle writer`);
  }

  if (requestedStatus !== undefined) {
    values.push(requestedStatus);
    setClauses.push(`status = $${values.length}`);
  }
  if (updates.metadata !== undefined) {
    // Use dialect helper for JSON merge - need to calculate the param index
    const paramIndex = values.length + 1;
    values.push(JSON.stringify(mutableRunMetadata(updates.metadata)));
    setClauses.push(`metadata = ${dialect.jsonMerge('metadata', paramIndex)}`);
  }
  if (updates.output_root !== undefined) {
    values.push(updates.output_root);
    // COALESCE makes write-once structural rather than doc-only (#2200): the
    // first non-null write sticks and every later one is a no-op, so a resume
    // that re-derived a different root (renamed codebase, #1192) can never
    // orphan the artifacts this run actually wrote. No behaviour change for the
    // executor, which already guards on a null pointer — this is the backstop
    // for any future caller that forgets to.
    setClauses.push(`output_root = COALESCE(output_root, $${values.length})`);
  }
  if (updates.working_path !== undefined) {
    values.push(updates.working_path);
    // Write-once, structurally, exactly like `output_root` above (#2872): a run
    // row created before its checkout existed — `run --detach` creates it in the
    // launching process, before the fork — gets its path from the process that
    // resolves the checkout, and no later writer can repoint a live run.
    setClauses.push(`working_path = COALESCE(working_path, $${values.length})`);
  }

  if (setClauses.length === 0) return;

  values.push(id);
  const idParam = `$${values.length}`;

  try {
    const result = await pool.query(
      `UPDATE remote_agent_workflow_runs SET ${setClauses.join(', ')} WHERE id = ${idParam}`,
      values
    );
    if (result.rowCount === 0) {
      getLog().warn({ workflowRunId: id }, 'db.workflow_run_update_no_match');
      throw new Error(`Workflow run not found (id: ${id})`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Workflow run not found')) throw error;
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_update_failed');
    throw new Error(`Failed to update workflow run: ${err.message}`);
  }
}

export function updateWorkflowRunMetadataIfRunning(
  id: string,
  metadata: WorkflowRun['metadata']
): Promise<boolean> {
  return mergeRunMetadataIfStatus(id, 'running', metadata);
}

export function updateWorkflowRunMetadataIfPending(
  id: string,
  metadata: WorkflowRun['metadata']
): Promise<boolean> {
  return mergeRunMetadataIfStatus(id, 'pending', metadata);
}

async function mergeRunMetadataIfStatus(
  id: string,
  status: 'running' | 'pending',
  metadata: WorkflowRun['metadata']
): Promise<boolean> {
  validateWorkflowWaitMetadata(metadata);
  const result = await pool.query(
    `UPDATE remote_agent_workflow_runs
     SET metadata = ${getDialect().jsonMerge('metadata', 2)}
     WHERE id = $1 AND status = $3`,
    [id, JSON.stringify(mutableRunMetadata(metadata)), status]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Atomically CLAIM the container write-back apply before the live root is mutated
 * (R2-F4). A conditional UPDATE that sets `metadata.writeback_apply_claimed = true`
 * only while it is unset — so exactly one resume wins the claim. Returns whether
 * THIS caller won. The caller must apply the overlay only on `claimed === true`, and
 * on apply FAILURE release the claim (`releaseWritebackClaim`) so a `workflow resume`
 * can retry. A claim that stays set without a recorded resolution (a crash, or a lost
 * resolution write) makes the next resume refuse to apply and fail the run for
 * operator reconciliation, so no path applies twice.
 */
export async function claimWriteback(id: string): Promise<{ claimed: boolean }> {
  const dialect = getDialect();
  const extract = getDialect().jsonText('metadata', 'writeback_apply_claimed');
  try {
    const result = await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET metadata = ${dialect.jsonMerge('metadata', 2)}
       WHERE id = $1 AND (${extract} IS NULL)`,
      [id, JSON.stringify({ writeback_apply_claimed: true })]
    );
    return { claimed: (result.rowCount ?? 0) > 0 };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_claim_writeback_failed');
    throw new Error(`Failed to claim write-back apply: ${err.message}`);
  }
}

/**
 * Release a previously-claimed write-back apply (R2-F4) after the apply FAILED, so a
 * subsequent `workflow resume` can re-claim and retry. The explicit null removes the
 * key on both dialects (see jsonMerge), so `claimWriteback`'s `IS NULL` check sees an
 * unclaimed run. Best-effort — a failure here leaves the
 * claim set (the volume is preserved regardless; the operator reconciles manually).
 */
export async function releaseWritebackClaim(id: string): Promise<void> {
  const dialect = getDialect();
  await pool.query(
    `UPDATE remote_agent_workflow_runs
     SET metadata = ${dialect.jsonMerge('metadata', 2)}
     WHERE id = $1`,
    [id, JSON.stringify({ writeback_apply_claimed: null })]
  );
}

/**
 * Update last_activity_at timestamp for a workflow run.
 * Used for activity-based staleness detection.
 * Throws on failure so callers can track consecutive failures.
 */
export async function updateWorkflowActivity(id: string): Promise<void> {
  const dialect = getDialect();
  await pool.query(
    `UPDATE remote_agent_workflow_runs SET last_activity_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
}

const terminalList = TERMINAL_WORKFLOW_STATUSES.map(status => `'${status}'`).join(', ');

/**
 * A run that left asks still open on its item is kept: its events hold the record of the
 * set (who answered, the settle), and its starter decides who may answer them. So is one
 * that left waits still open: its starter decides who may withdraw them, and the stage they
 * wake reads its result. Cleanup deletes it once the sets are closed. `id` is cast because `run_id` is TEXT and a run id
 * is a UUID on PostgreSQL.
 */
const NO_OPEN_ASKS = `NOT EXISTS (
  SELECT 1 FROM remote_agent_item_asks
  WHERE remote_agent_item_asks.run_id = CAST(remote_agent_workflow_runs.id AS TEXT)
    AND remote_agent_item_asks.closed_as IS NULL)
  AND NOT EXISTS (
  SELECT 1 FROM remote_agent_item_waits
  WHERE remote_agent_item_waits.run_id = CAST(remote_agent_workflow_runs.id AS TEXT)
    AND remote_agent_item_waits.closed_as IS NULL)`;

/**
 * A run with a sub-run that has not ended, at any depth, is kept: deleting it nulls the
 * sub-run's parent link (ON DELETE SET NULL), which splits the tree `concurrency.runs`
 * counts as one. The walk goes up from every live run, like `countedTrees`, so it keeps a
 * finished middle run too and the tree is never half deleted.
 */
const NO_LIVE_DESCENDANTS = `remote_agent_workflow_runs.id NOT IN (
  WITH RECURSIVE up(id, parent_run_id) AS (
    SELECT id, parent_run_id FROM remote_agent_workflow_runs WHERE status NOT IN (${terminalList})
    UNION
    SELECT p.id, p.parent_run_id FROM remote_agent_workflow_runs p JOIN up ON p.id = up.parent_run_id)
  SELECT id FROM up)`;

/**
 * Lock the runs `seed` selects and every run below them, and return their ids. A deletion
 * decides on a tree, so the tree must hold still until it commits: on PostgreSQL, a sub-run's
 * insert takes a key-share lock on its parent row and a revival updates the run's own row,
 * so both wait for this transaction, and the checks after the lock read what they committed.
 *
 * One pass is not enough. Its walk reads the snapshot its statement started with, so a
 * sub-run committed while the pass waited for a lock is missed, and could later be revived
 * unlocked. The walk repeats until a pass adds no run. A pass that adds none waited on no
 * lock, because it only re-locks rows this transaction already holds, so its snapshot holds
 * every committed run of the tree, and each is locked.
 *
 * SQLite serializes writers and reruns a transaction whose read went stale, so the walk
 * there only reads, and its second pass finds nothing new.
 */
async function lockRunTrees(
  query: TransactionQuery,
  seed: string,
  params: unknown[]
): Promise<Set<string>> {
  const locked = new Set<string>();
  for (;;) {
    const pass = await query<{ id: string }>(
      `WITH RECURSIVE tree(id) AS (
         ${seed}
         UNION
         SELECT c.id FROM remote_agent_workflow_runs c JOIN tree ON c.parent_run_id = tree.id)
       SELECT r.id FROM remote_agent_workflow_runs r JOIN tree ON r.id = tree.id${getDialect().rowLock('r')}`,
      params
    );
    const before = locked.size;
    for (const row of pass.rows) locked.add(String(row.id));
    if (locked.size === before) return locked;
  }
}

/** A `$n` parameter holding a JSON array of run ids, as a set to match `id IN (...)` against. */
function runIdSet(parameter: string): string {
  return getDatabaseType() === 'postgresql'
    ? `SELECT value::uuid FROM json_array_elements_text(${parameter}::json) AS ids(value)`
    : `SELECT value FROM json_each(${parameter})`;
}

/**
 * Delete terminal workflow runs older than the given number of days, except those kept above.
 * Returns the count of deleted runs. The candidates and their trees are locked first, and
 * only runs that were locked and then judged eligible are deleted, so eligibility cannot
 * change between the events delete and the runs delete.
 */
export async function deleteOldWorkflowRuns(olderThanDays: number): Promise<{ count: number }> {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 0) {
    throw new Error(
      `Invalid olderThanDays: ${String(olderThanDays)} (must be a non-negative integer)`
    );
  }
  const cutoff = getDialect().nowMinusDays(1);
  const old = `status IN (${terminalList})
    AND started_at < ${cutoff}
    AND COALESCE(active_phase_started_at, started_at) < ${cutoff}`;
  try {
    return await getDatabase().withTransaction(async query => {
      const locked = await lockRunTrees(
        query,
        `SELECT id FROM remote_agent_workflow_runs WHERE ${old}`,
        [olderThanDays]
      );
      const eligible = await query<{ id: string }>(
        `SELECT id FROM remote_agent_workflow_runs
          WHERE ${old} AND ${NO_OPEN_ASKS} AND ${NO_LIVE_DESCENDANTS}`,
        [olderThanDays]
      );
      const ids = eligible.rows.map(row => String(row.id)).filter(id => locked.has(id));
      if (ids.length === 0) return { count: 0 };
      const list = [JSON.stringify(ids)];
      // Delete events first (FK reference)
      await query(
        `DELETE FROM remote_agent_workflow_events WHERE workflow_run_id IN (${runIdSet('$1')})`,
        list
      );
      const result = await query(
        `DELETE FROM remote_agent_workflow_runs WHERE id IN (${runIdSet('$1')})`,
        list
      );
      return { count: result.rowCount ?? 0 };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, olderThanDays }, 'db.workflow_runs_cleanup_failed');
    throw new Error(`Failed to clean up old workflow runs: ${err.message}`);
  }
}

/**
 * Delete a workflow run and its associated events.
 * Only terminal runs (completed, failed, cancelled) can be deleted, and not one that left
 * asks or waits still open: those asks would have no rule for who may answer them and no
 * run to record the answer on, and those waits none for who may withdraw them. Nor one with
 * a sub-run, at any depth, that has not ended: deleting it nulls the sub-run's parent link,
 * which splits the tree `concurrency.runs` counts as one. Every refusal is a
 * `WorkflowRunDeleteRefusedError` whose message names what to do first.
 */
export async function deleteWorkflowRun(id: string): Promise<void> {
  try {
    await getDatabase().withTransaction(async query => {
      await lockRunTrees(query, 'SELECT id FROM remote_agent_workflow_runs WHERE id = $1', [id]);
      // Guard: verify run exists and is terminal before deleting
      const check = await query<{ status: string }>(
        'SELECT status FROM remote_agent_workflow_runs WHERE id = $1',
        [id]
      );
      if (check.rows.length === 0) {
        throw new WorkflowRunDeleteRefusedError(`Workflow run not found: ${id}`);
      }
      if (!TERMINAL_WORKFLOW_STATUSES.includes(check.rows[0].status as WorkflowRunStatus)) {
        throw new WorkflowRunDeleteRefusedError(
          `Cannot delete workflow run in '${check.rows[0].status}' status — cancel it first`
        );
      }
      const asks = await query<{ open: number | string }>(
        'SELECT COUNT(*) AS open FROM remote_agent_item_asks WHERE run_id = $1 AND closed_as IS NULL',
        [id]
      );
      const open = Number(asks.rows[0]?.open ?? 0);
      if (open > 0) {
        throw new WorkflowRunDeleteRefusedError(
          `Cannot delete workflow run ${id}: it left ${String(open)} open ask(s) on its item. Answer or withdraw them first (archon workflow answer --withdraw <ref>); archon workflow attention lists their refs.`
        );
      }
      const waits = await query<{ open: number | string }>(
        'SELECT COUNT(*) AS open FROM remote_agent_item_waits WHERE run_id = $1 AND closed_as IS NULL',
        [id]
      );
      if (Number(waits.rows[0]?.open ?? 0) > 0) {
        throw new WorkflowRunDeleteRefusedError(
          `Cannot delete workflow run ${id}: its item still waits for what it named (returns.waits). Withdraw the waits first (archon workflow answer --withdraw wait:${id}).`
        );
      }
      const live = await query<{ id: string; status: string }>(
        `WITH RECURSIVE down(id) AS (
           SELECT id FROM remote_agent_workflow_runs WHERE parent_run_id = $1
           UNION
           SELECT c.id FROM remote_agent_workflow_runs c JOIN down ON c.parent_run_id = down.id)
         SELECT r.id, r.status FROM remote_agent_workflow_runs r JOIN down ON r.id = down.id
          WHERE r.status NOT IN (${terminalList})
          ORDER BY r.started_at, r.id`,
        [id]
      );
      if (live.rows.length > 0) {
        throw liveDescendantsRefusal(
          id,
          live.rows.map(row => ({ id: String(row.id), status: row.status }))
        );
      }
      await query('DELETE FROM remote_agent_workflow_events WHERE workflow_run_id = $1', [id]);
      await query('DELETE FROM remote_agent_workflow_runs WHERE id = $1', [id]);
    });
  } catch (error) {
    if (error instanceof WorkflowRunDeleteRefusedError) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_delete_failed');
    throw new Error(`Failed to delete workflow run: ${err.message}`);
  }
}
