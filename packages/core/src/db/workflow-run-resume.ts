/**
 * Resume of workflow runs: finding a chat conversation's resumable run, the resume compare-and-swap,
 * fan-out child recovery and paused-run slot release. Re-exported from the
 * `./workflows` entry.
 */
import { CANCELLED_REASON_METADATA_KEY } from '@archon/workflows/schemas/run-metadata';
import { resumeTransition } from '@archon/workflows/resume-transition';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  CAPACITY_WAIT_METADATA_KEY,
  TOOL_CALL_ATTENTION_METADATA_KEY,
  readCapacityWait,
  workflowRunStatusSchema,
} from '@archon/workflows/schemas/workflow-run';
import { resourceResumeBlocker, resumeRefusal } from '@archon/workflows/resource-start-store';
import {
  EXECUTION_CLAIM_METADATA_KEY,
  FAN_OUT_CANCEL_REASONS,
  WorkflowNotResumableError,
  WorkflowItemHeldError,
  WorkflowResourceBusyError,
  type RunLimitError,
  pauseCursorMatches,
  requireOwnerlessLease,
  resumeCursorMatches,
  type PauseCursor,
  type ResumeClaimCursor,
} from '@archon/workflows/store';
import { getDatabase, getDatabaseType, getDialect, pool } from './connection';
import {
  addResourceSlotHolder,
  heldItemRefusal,
  lockResourceSlot,
  lockResourceSlotForAdmission,
  removeResourceSlotHolder,
  resourceStartOccupancy,
  runLimitRefusal,
  type TransactionQuery,
} from './resource-slots';
import { insertWorkflowEvent } from './workflow-events';
import { normalizeWorkflowRun, type WorkflowRunRow } from './workflow-run-normalization';
import { getLog, normalizeMetadata } from './workflow-run-shared';

/**
 * List every resumable (failed/paused) run of a workflow scoped to (parent conversation,
 * codebase). The orchestrator (all platforms) continues one only when it is the single run a
 * chat message could continue; with more than one it continues none and lists them. Codebase
 * scope prevents cross-project resume on persistent chat conversation IDs (Telegram chat_id,
 * Slack thread, etc.).
 *
 * The order (paused first, then newest within a status) only orders that listing.
 */
export async function listResumableRunsByParentConversation(
  workflowName: string,
  parentConversationId: string,
  codebaseId: string
): Promise<WorkflowRun[]> {
  try {
    const result = await pool.query<WorkflowRunRow>(
      `SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs
       WHERE workflow_name = $1
         AND parent_conversation_id = $2
         AND codebase_id = $3
         AND status IN ('failed', 'paused')
       ORDER BY CASE WHEN status = 'paused' THEN 0 ELSE 1 END, started_at DESC`,
      [workflowName, parentConversationId, codebaseId]
    );
    return result.rows.map(normalizeWorkflowRun);
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, workflowName, parentConversationId, codebaseId },
      'db.workflow_run_list_resumable_by_parent_failed'
    );
    throw new Error(`Failed to list resumable runs by parent conversation: ${err.message}`);
  }
}

type PriorRunRow = Pick<WorkflowRunRow, 'status' | 'metadata' | 'parent_run_id'> & {
  resource_key?: string | null;
  item_id?: string | null;
};

/** Pin the run row (and its admitted resource request, if any) for the resume transaction. */
async function lockPriorRun(query: TransactionQuery, id: string): Promise<PriorRunRow | undefined> {
  // Acquire the SQLite writer lock before taking a snapshot. Without this,
  // another process can commit between the SELECT and our first UPDATE and
  // make the deferred transaction fail its read-to-write upgrade.
  if (getDatabaseType() === 'sqlite') {
    await query('UPDATE remote_agent_workflow_runs SET id = id WHERE id = $1', [id]);
  }
  const priorRows = await query<PriorRunRow>(
    `SELECT w.status, w.metadata, q.resource_key, w.item_id, w.parent_run_id
       FROM remote_agent_workflow_runs w
       LEFT JOIN remote_agent_resource_start_requests q
         ON q.id = w.id AND q.status = 'admitted'
      WHERE w.id = $1${getDialect().rowLock('w')}`,
    [id]
  );
  return priorRows.rows[0];
}

function priorMatchesCursor(prior: PriorRunRow, cursor: ResumeClaimCursor | undefined): boolean {
  return (
    cursor === undefined ||
    resumeCursorMatches(
      {
        status: workflowRunStatusSchema.parse(prior.status),
        metadata: normalizeMetadata(prior.metadata),
      },
      cursor
    )
  );
}

/**
 * Take a slot on the run's admitted resource before it resumes, or return the refusal when the
 * resource is busy. A run with no admitted resource takes no slot. A `running` run resumed
 * with an `ownerless` cursor keeps the slot it already holds (`casResumeRun` refuses it
 * when it holds none).
 */
async function claimResourceSlot(
  query: TransactionQuery,
  id: string,
  prior: PriorRunRow,
  cursor: ResumeClaimCursor | undefined
): Promise<WorkflowResourceBusyError | undefined> {
  const resourceKey = prior.resource_key ?? undefined;
  const status = prior.status;
  if (resourceKey === undefined || (status !== 'failed' && status !== 'paused')) return undefined;
  const { capacity } = await lockResourceSlotForAdmission(query, resourceKey);
  const metadata = normalizeMetadata(prior.metadata);
  const occupancy = await resourceStartOccupancy(query, resourceKey, capacity);
  const blocker = resourceResumeBlocker(occupancy, { id, status, metadata });
  if (!blocker) {
    await addResourceSlotHolder(query, resourceKey, { kind: 'run', id });
    return undefined;
  }
  const busy = new WorkflowResourceBusyError(
    id,
    blocker,
    resumeRefusal({ status, metadata }, cursor)
  );
  // Committed with the refusal, so the paused run keeps its place as a waiter.
  if (busy.refusal === 'waiting' && readCapacityWait(metadata) === undefined)
    await query(
      `UPDATE remote_agent_workflow_runs SET metadata = ${getDialect().jsonMerge('metadata', 2)}
        WHERE id = $1`,
      [id, JSON.stringify({ [CAPACITY_WAIT_METADATA_KEY]: { since: new Date().toISOString() } })]
    );
  return busy;
}

/**
 * Advance path priority on resume without changing run creation time. Otherwise an
 * old resumer would sort ahead of a current holder and bypass checkout exclusion.
 *
 * Compare-and-swap guard: flip to 'running' only if the row is STILL resumable. A
 * failed or paused run is. A 'running' run is only with an `ownerless` cursor, and only
 * while its execution claim is still the one the caller read. Every resume mints a new
 * claim (`resumeTransition`), so of two concurrent resumers the second misses and gets
 * rowCount 0. Without it two callers (web Resume + a chat re-dispatch, or two CLI
 * resumes of a killed run) could both start an executor for the same run and
 * double-claim the worktree. An admitted 'running' run must still hold its resource
 * slot; it keeps that slot and takes no other.
 *
 * The CAS also clears `metadata.error` and `metadata.stop_reason` so a run that
 * fails, is resumed, and then completes doesn't keep rendering its old failure
 * (#2329) or claiming an operator interrupted it (#3479). Because
 * legacy runs may carry their only failure record in metadata (#2348), the error being
 * cleared is first preserved as a `workflow_resumed` event, in the SAME
 * transaction as the clear, so the audit trail can never lose it. The stop reason
 * needs no such preservation: `failWorkflowRun` wrote the same category onto the
 * terminal `workflow_failed` event, which a resume never touches. The read,
 * the CAS and the event INSERT are one transaction (mirroring
 * resolveApprovalGate, #2146): the row is pinned by dialect.rowLock() so the
 * value read is the value cleared, and the event is written ONLY by the
 * caller whose CAS matched — a losing concurrent resumer writes nothing.
 * Read-then-UPDATE rather than UPDATE…RETURNING because the SQLite adapter
 * rejects RETURNING on UPDATE and points at exactly this pattern.
 */
async function casResumeRun(
  query: TransactionQuery,
  id: string,
  prior: PriorRunRow,
  cursor: ResumeClaimCursor | undefined
): Promise<WorkflowRun | undefined> {
  const dialect = getDialect();
  const { metadataPatch, events } = resumeTransition({
    id,
    status: workflowRunStatusSchema.parse(prior.status),
    metadata: normalizeMetadata(prior.metadata),
  });

  const params: unknown[] = [id, JSON.stringify(metadataPatch)];
  let resumable = "status IN ('failed', 'paused')";
  if (cursor?.kind === 'ownerless') {
    const claim = dialect.jsonText('metadata', EXECUTION_CLAIM_METADATA_KEY);
    if (cursor.executionClaim === null) resumable = `status = 'running' AND ${claim} IS NULL`;
    else {
      params.push(cursor.executionClaim);
      resumable = `status = 'running' AND ${claim} = $3`;
    }
    resumable += ` AND (
         NOT EXISTS (
           SELECT 1 FROM remote_agent_resource_start_requests q
            WHERE q.id = $1 AND q.status = 'admitted'
         )
         OR EXISTS (
           SELECT 1 FROM remote_agent_resource_start_requests q
             JOIN remote_agent_resource_slot_holders h
               ON h.resource_key = q.resource_key
              AND h.holder_kind = 'run'
              AND h.holder_id = CAST(q.id AS TEXT)
            WHERE q.id = $1 AND q.status = 'admitted'
         )
       )`;
  }
  const result = await query(
    `UPDATE remote_agent_workflow_runs
     SET status = 'running',
         completed_at = NULL,
         active_phase_started_at = ${dialect.now()},
         last_activity_at = ${dialect.now()},
         metadata = ${dialect.jsonMerge('metadata', 2)}
     WHERE id = $1
       AND ${resumable}`,
    params
  );

  if (result.rowCount === 0) return undefined;
  for (const event of events) await insertWorkflowEvent(query, event);
  const selected = await query<WorkflowRunRow>(
    'SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs WHERE id = $1',
    [id]
  );
  const row = selected.rows[0];
  if (!row) throw new Error(`Workflow run vanished after update (id: ${id})`);
  return normalizeWorkflowRun(row);
}

export async function resumeWorkflowRun(
  id: string,
  cursor?: ResumeClaimCursor
): Promise<WorkflowRun> {
  requireOwnerlessLease(id, cursor);
  let updateResult:
    | { rowCount: 0 }
    | { busy: WorkflowResourceBusyError | WorkflowItemHeldError | RunLimitError }
    | { admitted: WorkflowRun };
  try {
    updateResult = await getDatabase().withTransaction(async query => {
      const prior = await lockPriorRun(query, id);
      if (!prior || !priorMatchesCursor(prior, cursor)) return { rowCount: 0 };
      // A paused or running run still holds its item; a failed one gave it up.
      const held =
        prior.status === 'failed' && prior.item_id != null
          ? await heldItemRefusal(query, id, ['failed'])
          : undefined;
      if (held) return { busy: held };
      // A failed root's claim ended, so its resume is new work under the run limit. Checked
      // before the slot is taken: this refusal must leave nothing behind.
      const full =
        prior.status === 'failed' && prior.parent_run_id == null
          ? await runLimitRefusal(query)
          : undefined;
      if (full) return { busy: full };
      const busy = await claimResourceSlot(query, id, prior, cursor);
      if (busy) return { busy };
      const admitted = await casResumeRun(query, id, prior, cursor);
      return admitted ? { admitted } : { rowCount: 0 };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_resume_failed');
    throw new Error(`Failed to resume workflow run: ${err.message}`);
  }
  if ('busy' in updateResult) throw updateResult.busy;

  if ('rowCount' in updateResult) {
    // CAS miss: the row is no longer resumable — deleted, terminal, or already
    // activated by another caller. Refuse rather than double-claim the worktree.
    // Probe the current status for an actionable error (informational only; the
    // probe rethrows on its own failure).
    let probeRows: readonly { status: string }[];
    try {
      const probe = await pool.query<{ status: string }>(
        'SELECT status FROM remote_agent_workflow_runs WHERE id = $1',
        [id]
      );
      probeRows = probe.rows;
    } catch (error) {
      const err = error as Error;
      getLog().error({ err, workflowRunId: id }, 'db.workflow_run_resume_probe_failed');
      throw new Error(`Failed to resume workflow run: ${err.message}`, { cause: err });
    }
    const currentStatus = probeRows[0]?.status;
    if (currentStatus === undefined) {
      getLog().warn({ workflowRunId: id }, 'db.workflow_run_resume_not_found');
      throw new Error(`Workflow run not found (id: ${id})`);
    }
    getLog().info({ workflowRunId: id, currentStatus }, 'db.workflow_run_resume_not_resumable');
    throw new WorkflowNotResumableError(id, currentStatus);
  }

  return updateResult.admitted;
}

export async function recoverCancelledFanOutRun(id: string): Promise<WorkflowRun> {
  const dialect = getDialect();
  const cancelledReason = dialect.jsonText('metadata', CANCELLED_REASON_METADATA_KEY);
  const metadataWithoutCancelledReason = dialect.jsonRemove(
    'metadata',
    CANCELLED_REASON_METADATA_KEY
  );
  const eventReason = dialect.jsonText('data', 'reason');
  // Placeholders follow the reason list, so a new fan-out cancel reason needs no SQL edit.
  const reasonPlaceholders = (first: number): string =>
    FAN_OUT_CANCEL_REASONS.map((_, i) => `$${String(first + i)}`).join(', ');

  try {
    return await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'running',
             completed_at = NULL,
             active_phase_started_at = ${dialect.now()},
             last_activity_at = ${dialect.now()},
             metadata = ${dialect.jsonMerge(metadataWithoutCancelledReason, 2)}
         WHERE id = $1
           AND status = 'cancelled'
           AND ${cancelledReason} IN (${reasonPlaceholders(3)})`,
        [
          id,
          JSON.stringify({
            [TOOL_CALL_ATTENTION_METADATA_KEY]: null,
            [EXECUTION_CLAIM_METADATA_KEY]: crypto.randomUUID(),
          }),
          ...FAN_OUT_CANCEL_REASONS,
        ]
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new Error(`Workflow run is not an engine-cancelled fan-out child (id: ${id})`);
      }
      await query(
        `DELETE FROM remote_agent_workflow_events
         WHERE workflow_run_id = $1
           AND event_type = 'workflow_cancelled'
           AND ${eventReason} IN (${reasonPlaceholders(2)})`,
        [id, ...FAN_OUT_CANCEL_REASONS]
      );
      await insertWorkflowEvent(query, { workflow_run_id: id, event_type: 'workflow_resumed' });
      const recovered = await query<WorkflowRunRow>(
        'SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs WHERE id = $1',
        [id]
      );
      const row = recovered.rows[0];
      if (!row) throw new Error(`Workflow run not found after fan-out recovery (id: ${id})`);
      return normalizeWorkflowRun(row);
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Workflow run ')) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_fan_out_recover_failed');
    throw new Error(`Failed to recover cancelled fan-out run: ${err.message}`);
  }
}

/**
 * Give back the resource slot of an admitted run still paused at exactly `cursor`
 * (`IWorkflowStore.releasePausedRunSlot`). The run row is pinned and the slot locked in
 * the same transaction, so the release never races the resume that reacquires it.
 */
export async function releasePausedRunSlot(
  id: string,
  cursor: PauseCursor
): Promise<{ released: boolean }> {
  return getDatabase().withTransaction(async query => {
    if (getDatabaseType() === 'sqlite') {
      await query('UPDATE remote_agent_workflow_runs SET id = id WHERE id = $1', [id]);
    }
    const rows = await query<{ status: string; metadata: unknown; resource_key: string | null }>(
      `SELECT w.status, w.metadata, q.resource_key
         FROM remote_agent_workflow_runs w
         LEFT JOIN remote_agent_resource_start_requests q
           ON q.id = w.id AND q.status = 'admitted'
        WHERE w.id = $1${getDialect().rowLock('w')}`,
      [id]
    );
    const row = rows.rows[0];
    if (
      !row?.resource_key ||
      !pauseCursorMatches(
        {
          status: workflowRunStatusSchema.parse(row.status),
          metadata: normalizeMetadata(row.metadata),
        },
        cursor
      )
    )
      return { released: false };
    await lockResourceSlot(query, row.resource_key);
    const released = await removeResourceSlotHolder(query, row.resource_key, { kind: 'run', id });
    if (released)
      await query(
        `UPDATE remote_agent_workflow_runs SET metadata = ${getDialect().jsonMerge('metadata', 2)}
          WHERE id = $1`,
        [id, JSON.stringify({ [CAPACITY_WAIT_METADATA_KEY]: null })]
      );
    return { released };
  });
}
