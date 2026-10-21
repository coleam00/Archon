import {
  prepareResumedRun,
  resumePreparationUndo,
  restoreResumePreparation,
  type ResumePreparationUndo,
} from '@archon/workflows/resume-preparation';
/**
 * Resume of workflow runs: finding a resumable run, the resume compare-and-swap,
 * fan-out child recovery and paused-run slot release. Re-exported from the
 * `./workflows` entry.
 */
import type { ScheduledWorkflowResume, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  CAPACITY_WAIT_METADATA_KEY,
  RUN_STOP_REASON_METADATA_KEY,
  SOURCE_RELEASE_METADATA_KEY,
  TOOL_CALL_ATTENTION_METADATA_KEY,
  isScheduledWorkflowResume,
  pausedUsageLimitWait,
  readCapacityWait,
  workflowRunStatusSchema,
} from '@archon/workflows/schemas/workflow-run';
import { resourceResumeBlocker, resumeRefusal } from '@archon/workflows/resource-start-store';
import {
  EXECUTION_CLAIM_METADATA_KEY,
  FAN_OUT_CANCEL_REASONS,
  WorkflowNotResumableError,
  WorkflowResourceBusyError,
  pauseCursorMatches,
  resumeCursorMatches,
  workflowUnpausedEvent,
  type PauseCursor,
  type WorkflowResumeCursor,
} from '@archon/workflows/store';
import type { SqlDialect } from './adapters/types';
import { getDatabase, getDatabaseType, getDialect, pool } from './connection';
import {
  addResourceSlotHolder,
  lockResourceSlot,
  removeResourceSlotHolder,
  resourceStartOccupancy,
} from './resource-slots';
import { insertWorkflowEvent } from './workflow-events';
import { normalizeWorkflowRun, type WorkflowRunRow } from './workflow-run-normalization';
import { getLog, normalizeMetadata } from './workflow-run-shared';

/**
 * Days of inactivity after which a 'running' run is treated as an orphan (its
 * executor presumed dead) and becomes eligible for resume. Bound as a query
 * parameter — never interpolated — so both dialects handle it positionally.
 */
const ORPHAN_RESUME_STALE_DAYS = 1;

/**
 * SQL fragment matching a run that may be resumed: failed/paused, or a stale
 * 'running' orphan (no activity for ORPHAN_RESUME_STALE_DAYS). `dayParamIndex`
 * is the 1-based placeholder position at which the caller MUST bind
 * ORPHAN_RESUME_STALE_DAYS. Shared by findResumableRun and resumeWorkflowRun so
 * the two predicates cannot drift — a hand-duplicated copy did drift and bound
 * the wrong placeholder, breaking resume (PR #1830 review C1).
 */
function resumableStatusClause(dialect: SqlDialect, dayParamIndex: number): string {
  const staleOrphan = `last_activity_at IS NULL OR last_activity_at < ${dialect.nowMinusDays(dayParamIndex)}`;
  return `(status IN ('failed', 'paused') OR (status = 'running' AND (${staleOrphan})))`;
}

/**
 * Extract a non-empty `metadata.error` string from a raw column value, or null
 * when there is nothing worth preserving. SQLite stores metadata as JSON TEXT
 * and Postgres returns a parsed object (same split normalizeWorkflowRun handles),
 * so both shapes are accepted; absent / null / non-string / empty / unparseable
 * all collapse to null.
 */
function readMetadataError(raw: unknown): string | null {
  const error = normalizeMetadata(raw).error;
  return typeof error === 'string' && error !== '' ? error : null;
}

function readScheduledResume(raw: unknown): ScheduledWorkflowResume | null {
  const scheduled = normalizeMetadata(raw).scheduled_resume;
  return isScheduledWorkflowResume(scheduled) ? scheduled : null;
}

export async function findResumableRun(
  workflowName: string,
  workingPath: string
): Promise<WorkflowRun | null> {
  const dialect = getDialect();
  try {
    const result = await pool.query<WorkflowRunRow>(
      `SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs
       WHERE workflow_name = $1
         AND working_path = $2
         AND ${resumableStatusClause(dialect, 3)}
         AND (
           status <> 'running'
           OR NOT EXISTS (
             SELECT 1 FROM remote_agent_resource_start_requests q
              WHERE q.id = remote_agent_workflow_runs.id AND q.status = 'admitted'
           )
         )
       ORDER BY started_at DESC
       LIMIT 1`,
      [workflowName, workingPath, ORPHAN_RESUME_STALE_DAYS]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, errorType: err.constructor.name, workflowName, workingPath },
      'db.workflow_run_find_resumable_failed'
    );
    throw new Error(`Failed to find resumable run: ${err.message}`);
  }
}

/**
 * Find a resumable (failed/paused) run for a workflow scoped to (parent conversation, codebase).
 * Used by the orchestrator (all platforms) to detect approved runs that need foreground resume
 * on the prior run's worktree. Codebase scope prevents cross-project resume on persistent
 * chat conversation IDs (Telegram chat_id, Slack thread, etc.).
 *
 * Ordering is status-first, then recency WITHIN a status — not bare recency. The two statuses
 * are not interchangeable candidates for the caller: a `paused` run is an open gate that is
 * legitimately waiting and gets hydrated and resumed, while a `failed` one is deliberately gated
 * behind an explicit user prompt first (#1549). Ordering purely by `started_at` therefore lets a
 * newer failure shadow an older open gate, and approving that gate resumes nothing.
 *
 * Contrast with getActiveWorkflowRunByPath, which sorts the opposite way (older-wins) —
 * it answers "who took the path lock first", a different question.
 */
export async function findResumableRunByParentConversation(
  workflowName: string,
  parentConversationId: string,
  codebaseId: string
): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRunRow>(
      `SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs
       WHERE workflow_name = $1
         AND parent_conversation_id = $2
         AND codebase_id = $3
         AND status IN ('failed', 'paused')
       ORDER BY CASE WHEN status = 'paused' THEN 0 ELSE 1 END, started_at DESC
       LIMIT 1`,
      [workflowName, parentConversationId, codebaseId]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, workflowName, parentConversationId, codebaseId },
      'db.workflow_run_find_resumable_by_parent_failed'
    );
    throw new Error(`Failed to find resumable run by parent conversation: ${err.message}`);
  }
}

function resumeMetadata(prior: Pick<WorkflowRunRow, 'status' | 'metadata'> | undefined) {
  const scheduled = prior?.status === 'failed' ? readScheduledResume(prior.metadata) : null;
  const triggeredAt = scheduled?.triggeredAt === undefined ? new Date().toISOString() : null;
  // A usage-limit wait ends when its run is claimed; the nodes that hit the limit run again.
  const usageLimitWait =
    prior?.status === 'paused' &&
    pausedUsageLimitWait({ status: 'paused', metadata: normalizeMetadata(prior.metadata) }) !==
      undefined;
  const metadataPatch = {
    ...(usageLimitWait ? { wait: null } : {}),
    [TOOL_CALL_ATTENTION_METADATA_KEY]: null,
    error: null,
    [RUN_STOP_REASON_METADATA_KEY]: null,
    continuation_retry_at: null,
    [CAPACITY_WAIT_METADATA_KEY]: null,
    [SOURCE_RELEASE_METADATA_KEY]: null,
    [EXECUTION_CLAIM_METADATA_KEY]: crypto.randomUUID(),
    ...(scheduled !== null && triggeredAt !== null
      ? { scheduled_resume: { ...scheduled, triggeredAt } }
      : {}),
  };

  return { metadataPatch, scheduled, triggeredAt };
}

export async function resumeWorkflowRun(
  id: string,
  cursor?: WorkflowResumeCursor,
  prepare?: (admitted: WorkflowRun) => Promise<void>
): Promise<WorkflowRun> {
  const dialect = getDialect();

  let updateResult:
    | { rowCount: 0 }
    | { busy: WorkflowResourceBusyError }
    | {
        admitted: WorkflowRun;
        undo: ResumePreparationUndo | undefined;
        eventIds: string[];
        acquiredResource: string | undefined;
      };
  try {
    // Refresh started_at to NOW so the resumed row competes fairly with
    // currently-active rows in getActiveWorkflowRunByPath's older-wins
    // tiebreaker. Without this, a resumed row carries its original
    // (potentially hours-old) started_at and would sort ahead of any
    // currently-running holder, slipping past the path lock and causing
    // two active workflows on the same working_path.
    //
    // We accept losing the original creation time here — `started_at` for
    // an active row semantically means "when did this active phase start."
    // The original creation time can be recovered from workflow_events
    // history if needed for analytics.
    // Compare-and-swap guard: flip to 'running' only if the row is STILL
    // resumable (resumableStatusClause — shared with findResumableRun so the two
    // predicates can't drift). The exclusion mechanism is the atomic row-level
    // UPDATE: because it also refreshes last_activity_at, a second concurrent
    // resumer finds the row already 'running' with fresh activity, no longer
    // matches the clause, and gets rowCount 0. Without it two callers (web
    // Resume + a chat re-dispatch, or the lock-less CLI path) could both flip
    // the same run to 'running' and double-claim the worktree. The day param is
    // bound at $2 (ORPHAN_RESUME_STALE_DAYS), matching findResumableRun's bind.
    //
    // The CAS also clears `metadata.error` and `metadata.stop_reason` so a run that
    // fails, is resumed, and then completes doesn't keep rendering its old failure
    // (#2329) or claiming an operator interrupted it (#3479). Because
    // legacy runs may carry their only failure record in metadata (#2348), the error being
    // cleared is first preserved as a `workflow_resumed` event, in the SAME
    // transaction as the clear, so the audit trail can never lose it. The stop reason
    // needs no such preservation: `failWorkflowRun` wrote the same category onto the
    // terminal `workflow_failed` event, which a resume never touches. The read,
    // the CAS and the event INSERT are one transaction (mirroring
    // resolveApprovalGate, #2146): the row is pinned by dialect.rowLock() so the
    // value read is the value cleared, and the event is written ONLY by the
    // caller whose CAS matched — a losing concurrent resumer writes nothing.
    // Read-then-UPDATE rather than UPDATE…RETURNING because the SQLite adapter
    // rejects RETURNING on UPDATE and points at exactly this pattern.
    updateResult = await getDatabase().withTransaction(async query => {
      // Acquire the SQLite writer lock before taking a snapshot. Without this,
      // another process can commit between the SELECT and our first UPDATE and
      // make the deferred transaction fail its read-to-write upgrade.
      if (getDatabaseType() === 'sqlite') {
        await query('UPDATE remote_agent_workflow_runs SET id = id WHERE id = $1', [id]);
      }
      const priorRows = await query<WorkflowRunRow & { resource_key?: string | null }>(
        `SELECT w.*, CAST(w.origin AS TEXT) AS origin, q.resource_key
           FROM remote_agent_workflow_runs w
           LEFT JOIN remote_agent_resource_start_requests q
             ON q.id = w.id AND q.status = 'admitted'
          WHERE w.id = $1${getDialect().rowLock('w')}`,
        [id]
      );
      const prior = priorRows.rows[0];
      if (
        cursor !== undefined &&
        (prior === undefined ||
          !resumeCursorMatches(
            {
              status: workflowRunStatusSchema.parse(prior.status),
              metadata: normalizeMetadata(prior.metadata),
            },
            cursor
          ))
      )
        return { rowCount: 0 };
      let acquiredResource: string | undefined;
      const resourceKey = prior?.resource_key ?? undefined;
      const status = prior?.status;
      if (resourceKey !== undefined && (status === 'failed' || status === 'paused')) {
        const { capacity } = await lockResourceSlot(query, resourceKey);
        const metadata = normalizeMetadata(prior?.metadata);
        const occupancy = await resourceStartOccupancy(query, resourceKey, capacity);
        const blocker = resourceResumeBlocker(occupancy, { id, status, metadata });
        if (blocker) {
          const busy = new WorkflowResourceBusyError(
            id,
            blocker,
            resumeRefusal({ status, metadata }, cursor)
          );
          // Committed with the refusal, so the paused run keeps its place as a waiter.
          if (busy.refusal === 'waiting' && readCapacityWait(metadata) === undefined)
            await query(
              `UPDATE remote_agent_workflow_runs SET metadata = ${dialect.jsonMerge('metadata', 2)}
                WHERE id = $1`,
              [
                id,
                JSON.stringify({
                  [CAPACITY_WAIT_METADATA_KEY]: { since: new Date().toISOString() },
                }),
              ]
            );
          return { busy };
        }
        if (!occupancy.holders.some(holder => holder.id === id)) acquiredResource = resourceKey;
        await addResourceSlotHolder(query, resourceKey, { kind: 'run', id });
      }
      const clearedError = readMetadataError(prior?.metadata);
      const { metadataPatch, scheduled, triggeredAt } = resumeMetadata(prior);

      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'running',
             completed_at = NULL,
             started_at = ${dialect.now()},
             last_activity_at = ${dialect.now()},
             metadata = ${dialect.jsonMerge('metadata', 3)}
         WHERE id = $1
           AND ${resumableStatusClause(dialect, 2)}
           AND (
             NOT EXISTS (
               SELECT 1 FROM remote_agent_resource_start_requests q
                WHERE q.id = $1 AND q.status = 'admitted'
             )
             OR status IN ('failed', 'paused')
           )`,
        [id, ORPHAN_RESUME_STALE_DAYS, JSON.stringify(metadataPatch)]
      );

      if (result.rowCount === 0) return { rowCount: 0 as const };
      const eventIds: string[] = [];
      if (prior?.status === 'failed' || clearedError !== null) {
        // Same `{ error }` payload shape workflow_failed uses, so every consumer
        // that already reads an error off a workflow_* event keeps working.
        eventIds.push(
          await insertWorkflowEvent(query, {
            workflow_run_id: id,
            event_type: 'workflow_resumed',
            data: clearedError === null ? {} : { error: clearedError },
          })
        );
      }
      if (prior?.status === 'paused') {
        eventIds.push(await insertWorkflowEvent(query, workflowUnpausedEvent(id)));
      }
      if (scheduled !== null && triggeredAt !== null) {
        eventIds.push(
          await insertWorkflowEvent(query, {
            workflow_run_id: id,
            event_type: 'quota_resume_triggered',
            data: { attempt: scheduled.attempt, resume_at: scheduled.resumeAt },
          })
        );
      }
      const selected = await query<WorkflowRunRow>(
        'SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs WHERE id = $1',
        [id]
      );
      const row = selected.rows[0];
      if (!row) throw new Error(`Workflow run vanished after update (id: ${id})`);
      const admitted = normalizeWorkflowRun(row);
      return {
        admitted,
        undo:
          prepare && prior
            ? resumePreparationUndo(normalizeWorkflowRun(prior), admitted)
            : undefined,
        eventIds,
        acquiredResource,
      };
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

  const { admitted, undo, eventIds, acquiredResource } = updateResult;
  if (!prepare) return admitted;
  if (!undo) throw new Error(`Resume admission has no preparation inverse: ${id}`);
  return prepareResumedRun(admitted, prepare, async () => {
    await getDatabase().withTransaction(async query => {
      if (getDatabaseType() === 'sqlite')
        await query('UPDATE remote_agent_workflow_runs SET id = id WHERE id = $1', [id]);
      const selected = await query<WorkflowRunRow>(
        `SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs
          WHERE id = $1${dialect.rowLock()}`,
        [id]
      );
      const current = selected.rows[0];
      if (!current) throw new Error(`Resume preparation run disappeared: ${id}`);
      const restored = restoreResumePreparation(normalizeWorkflowRun(current), undo);
      if (acquiredResource) await lockResourceSlot(query, acquiredResource);
      const result = await query(
        `UPDATE remote_agent_workflow_runs
          SET status = $2, started_at = $3, completed_at = $4, last_activity_at = $5, metadata = $6
          WHERE id = $1 AND status = 'running'
            AND ${dialect.jsonText('metadata', EXECUTION_CLAIM_METADATA_KEY)} = $7`,
        [
          id,
          restored.status,
          restored.started_at.toISOString(),
          restored.completed_at?.toISOString() ?? null,
          restored.last_activity_at?.toISOString() ?? null,
          JSON.stringify(restored.metadata),
          undo.claim,
        ]
      );
      if (result.rowCount === 0)
        throw new Error(`Resume preparation lost execution ownership: ${id}`);
      if (acquiredResource)
        await removeResourceSlotHolder(query, acquiredResource, { kind: 'run', id });
      for (const eventId of eventIds)
        await query(
          'DELETE FROM remote_agent_workflow_events WHERE id = $1 AND workflow_run_id = $2',
          [eventId, id]
        );
    });
  });
}

export async function recoverCancelledFanOutRun(id: string): Promise<WorkflowRun> {
  const dialect = getDialect();
  const cancelledReason = dialect.jsonText('metadata', 'cancelled_reason');
  const metadataWithoutCancelledReason = dialect.jsonRemove('metadata', 'cancelled_reason');
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
             started_at = ${dialect.now()},
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
