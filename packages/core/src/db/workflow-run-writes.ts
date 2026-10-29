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
  type WorkflowRunOutcome,
  type WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';
import { getDatabase, getDialect, pool } from './connection';
import { insertWorkflowEvent } from './workflow-events';
import { getWorkflowRun } from './workflow-run-reads';
import { getLog, lockedRunRow, normalizeMetadata } from './workflow-run-shared';

/** Guard error for deleteWorkflowRun — re-thrown without wrapping in the outer catch. */
class WorkflowRunGuardError extends Error {}

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
    outcome?: WorkflowRunOutcome;
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
  if (updates.outcome !== undefined) {
    values.push(updates.outcome);
    setClauses.push(`outcome = $${values.length}`);
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

export async function updateWorkflowRunMetadataIfRunning(
  id: string,
  metadata: WorkflowRun['metadata']
): Promise<boolean> {
  validateWorkflowWaitMetadata(metadata);
  const result = await pool.query(
    `UPDATE remote_agent_workflow_runs
     SET metadata = ${getDialect().jsonMerge('metadata', 2)}
     WHERE id = $1 AND status = 'running'`,
    [id, JSON.stringify(mutableRunMetadata(metadata))]
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

/**
 * Delete terminal workflow runs older than the given number of days.
 * Returns the count of deleted runs.
 */
export async function deleteOldWorkflowRuns(olderThanDays: number): Promise<{ count: number }> {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 0) {
    throw new Error(
      `Invalid olderThanDays: ${String(olderThanDays)} (must be a non-negative integer)`
    );
  }
  const cutoff = getDialect().nowMinusDays(1);
  try {
    return await getDatabase().withTransaction(async query => {
      // Delete events first (FK reference)
      await query(
        `DELETE FROM remote_agent_workflow_events WHERE workflow_run_id IN (
          SELECT id FROM remote_agent_workflow_runs
          WHERE status IN ('completed', 'failed', 'cancelled')
            AND started_at < ${cutoff}
        )`,
        [olderThanDays]
      );
      const result = await query(
        `DELETE FROM remote_agent_workflow_runs
         WHERE status IN ('completed', 'failed', 'cancelled')
           AND started_at < ${cutoff}`,
        [olderThanDays]
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
 * Only terminal runs (completed, failed, cancelled) can be deleted.
 */
export async function deleteWorkflowRun(id: string): Promise<void> {
  try {
    await getDatabase().withTransaction(async query => {
      // Guard: verify run exists and is terminal before deleting
      const check = await query<{ status: string }>(
        'SELECT status FROM remote_agent_workflow_runs WHERE id = $1',
        [id]
      );
      if (check.rows.length === 0) {
        throw new WorkflowRunGuardError(`Workflow run not found: ${id}`);
      }
      if (!TERMINAL_WORKFLOW_STATUSES.includes(check.rows[0].status as WorkflowRunStatus)) {
        throw new WorkflowRunGuardError(
          `Cannot delete workflow run in '${check.rows[0].status}' status — cancel it first`
        );
      }
      await query('DELETE FROM remote_agent_workflow_events WHERE workflow_run_id = $1', [id]);
      await query('DELETE FROM remote_agent_workflow_runs WHERE id = $1', [id]);
    });
  } catch (error) {
    if (error instanceof WorkflowRunGuardError) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_delete_failed');
    throw new Error(`Failed to delete workflow run: ${err.message}`);
  }
}
