/**
 * Database operations for workflow runs
 */
import { pool, getDialect, getDatabaseType, getDatabase } from './connection';
import { insertWorkflowEvent, listActiveWorkflowNodeIds } from './workflow-events';
import { toHydratedTimestamp, toDbTimestampParam } from './timestamps';
import type { OwnerlessClaimFilter } from './conversations';
import type { IDatabase, SqlDialect } from './adapters/types';
import type {
  WorkflowRun,
  WorkflowRunOutcome,
  WorkflowRunStatus,
  ApprovalContext,
  WorkflowAttentionWaitContext,
  WorkflowWaitContext,
  ScheduledWorkflowResume,
} from '@archon/workflows/schemas/workflow-run';
import {
  isWorkflowWaitContext,
  isScheduledWorkflowResume,
  scheduledWorkflowResumeSchema,
  workflowWaitStepName,
  workflowWaitContextSchema,
  TERMINAL_WORKFLOW_STATUSES,
} from '@archon/workflows/schemas/workflow-run';
import type {
  DashboardWorkflowRun,
  ListDashboardRunsOptions,
  DashboardRunsResult,
} from '../schemas/workflow-run';
import { createLogger } from '@archon/paths';
import type {
  FanOutCancelReason,
  WorkflowCancellationEventDetails,
  WorkflowEventType,
  WorkflowResumeCursor,
  WorkflowWaitCompletion,
  WorkflowWaitPause,
} from '@archon/workflows/store';
import { FAN_OUT_CANCEL_REASONS } from '@archon/workflows/store';

/** Best-effort ROLLBACK — log but swallow errors since we're already in an error path. */
function rollback(): Promise<void> {
  return pool.query('ROLLBACK', []).then(
    () => undefined,
    rollbackErr => {
      getLog().warn({ err: rollbackErr as Error }, 'db.rollback_failed');
    }
  );
}

/** Guard error for deleteWorkflowRun — re-thrown without wrapping in the outer catch. */
class WorkflowRunGuardError extends Error {}

/**
 * Normalize a WorkflowRun row from the database.
 * SQLite stores metadata as TEXT (JSON string) and timestamps as TEXT datetimes;
 * PostgreSQL returns parsed objects and real Dates. This makes both shapes match
 * the `WorkflowRun` type's promise for every consumer — downstream code may treat
 * them as a parsed object and a Date without re-guarding (a raw SQLite string once
 * crashed `resolveWorkflowAdoption` at `.toISOString()`, #2845).
 */
function normalizeWorkflowRun<T extends WorkflowRun>(row: T): T {
  if (typeof row.metadata === 'string') {
    try {
      row.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      row.metadata = {};
    }
  }
  if (typeof row.started_at === 'string') row.started_at = toHydratedTimestamp(row.started_at);
  if (typeof row.completed_at === 'string')
    row.completed_at = toHydratedTimestamp(row.completed_at);
  if (typeof row.last_activity_at === 'string')
    row.last_activity_at = toHydratedTimestamp(row.last_activity_at);
  return row;
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflows');
  return cachedLog;
}

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
 * `FOR UPDATE` on Postgres, empty on SQLite (which has no such syntax and does
 * not need it — the adapter serializes transactions on one connection, and a
 * cross-process writer that commits between our read and our write makes the
 * deferred BEGIN's read→write upgrade fail with SQLITE_BUSY rather than let a
 * stale snapshot through). Used to pin rows across a read-then-write pair so
 * the values read are the values the mutation acts on. Dialect-branched here
 * rather than in SqlDialect because this lock is local DB policy.
 */
function rowLockClause(): string {
  return getDatabaseType() === 'postgresql' ? ' FOR UPDATE' : '';
}

function normalizeMetadata(raw: unknown): Record<string, unknown> {
  let metadata = raw;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata) as unknown;
    } catch {
      return {};
    }
  }
  return typeof metadata === 'object' && metadata !== null
    ? (metadata as Record<string, unknown>)
    : {};
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

/**
 * SQL predicate matching a run whose approval gate is still OPEN: the row is
 * 'paused' AND metadata.approval.resolved is JSON null or absent. Dialect-aware
 * (Postgres `->>`, SQLite `json_extract`) and kept in ONE place so the two forms
 * cannot drift — mirrors resumableStatusClause and the local jsonIntExtract
 * helper. `->>'resolved'` / `json_extract(...)` both return SQL NULL for a JSON
 * null AND for an absent key, so `IS NULL` matches exactly "not yet resolved".
 * This is the compare-and-swap guard resolveApprovalGate uses to serialize
 * concurrent approve/reject.
 */
function unresolvedGateClause(): string {
  const resolvedExpr =
    getDatabaseType() === 'postgresql'
      ? "metadata->'approval'->>'resolved'"
      : "json_extract(metadata, '$.approval.resolved')";
  return `status = 'paused' AND ${resolvedExpr} IS NULL`;
}

/**
 * SQL expression writing a fresh approval gate: merge the caller's run-level
 * metadata into the column at the TOP level, then set `metadata.approval` to the
 * bound value WHOLESALE. Dialect-aware and kept in ONE place beside
 * unresolvedGateClause so the two forms cannot drift.
 *
 * Deliberately NOT dialect.jsonMerge, because the two merge operators disagree
 * one level down: Postgres `||` is shallow, so `approval` is replaced; SQLite's
 * json_patch is RFC 7396 and RECURSES, so a nested object like
 * `approval.signaledTokens` was merged key by key and interior keys the new gate
 * omitted survived from the previous gate — fabricating cache-token counts no
 * provider reported (#2673). Replacing the whole object makes "this gate's
 * context, and only this gate's" structural on both dialects instead of a list
 * of resets that every new nested field re-arms.
 *
 * @param mergeParamIndex - param holding top-level run metadata (may be `{}`)
 * @param approvalParamIndex - param holding the complete ApprovalContext
 */
function writeApprovalMetadata(mergeParamIndex: number, approvalParamIndex: number): string {
  const merge = `$${String(mergeParamIndex)}`;
  const approval = `$${String(approvalParamIndex)}`;
  return getDatabaseType() === 'postgresql'
    ? `jsonb_set((metadata - 'wait') || ${merge}::jsonb, '{approval}', ${approval}::jsonb, true)`
    : `json_set(json_patch(json_remove(metadata, '$.wait'), ${merge}), '$.approval', json(${approval}))`;
}

/** Replace the engine-owned wait object and remove any stale human approval. */
function replaceWaitMetadata(paramIndex: number): string {
  const value = `$${String(paramIndex)}`;
  const metadata =
    getDatabaseType() === 'postgresql'
      ? "metadata - 'approval'"
      : "json_remove(metadata, '$.approval')";
  return getDatabaseType() === 'postgresql'
    ? `jsonb_set(${metadata}, '{wait}', ${value}::jsonb, true)`
    : `json_set(${metadata}, '$.wait', json(${value}))`;
}

/**
 * An audit event written atomically with a gate resolution (#2146). The winning
 * resolver inserts these in the SAME transaction as the resolution UPDATE, so a
 * failed event write rolls the resolution back — a resolved gate can never be
 * left with no audit trail, which the fast-path guard would then wrongly block
 * from retrying. `workflow_run_id` is supplied by the CAS function.
 */
export interface GateResolutionEvent {
  event_type: WorkflowEventType;
  step_name: string;
  data: Record<string, unknown>;
}

/**
 * Atomically resolve a paused approval gate (compare-and-swap) and record its
 * audit events in one transaction.
 *
 * Merges `metadata` (which carries `approval.resolved = 'approved' | 'rejected'`
 * plus any gate-specific keys) into the row ONLY while the gate is still open
 * (unresolvedGateClause). When the CAS matches, the same transaction inserts
 * `events`; when it loses (rowCount 0) nothing is written. Returns
 * `{ resolved }`: `true` = this caller won the race and its events are committed;
 * `false` = a concurrent approve/reject already resolved the gate.
 *
 * This closes the read-then-write TOCTOU window in approveWorkflow /
 * rejectWorkflow: the atomic conditional UPDATE — not a prior in-memory
 * isGateResolved read — is the single arbiter of the resolution. The run STAYS
 * 'paused' (only metadata changes); the resume CAS (resumeWorkflowRun)
 * independently guards double-resume. Idempotent in content, so a lost race
 * corrupts nothing — it only prevents the duplicate events/telemetry (#2113).
 * Wrapping the resolution and its audit rows in one transaction closes the
 * separate gap where a post-commit event-write failure stranded a resolved gate
 * with no audit event and no way to retry (#2146).
 *
 * This one merges (unlike the wholesale pause write — writeApprovalMetadata) and
 * is safe to, because it stamps the SAME gate rather than opening a new one:
 * every caller passes `{ ...approval, resolved }`, the stored context plus fields,
 * so SQLite's deep-merge and a replace produce identical rows. A caller that ever
 * passed a PARTIAL approval would silently keep the stored values on SQLite and
 * drop them on Postgres — pass the whole context, or use the pause write's form.
 */
export async function resolveApprovalGate(
  id: string,
  metadata: Record<string, unknown>,
  events: GateResolutionEvent[]
): Promise<{ resolved: boolean }> {
  const dialect = getDialect();
  try {
    return await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET metadata = ${dialect.jsonMerge('metadata', 2)}
         WHERE id = $1 AND ${unresolvedGateClause()}`,
        [id, JSON.stringify(metadata)]
      );
      const resolved = (result.rowCount ?? 0) > 0;
      if (resolved) {
        for (const event of events) {
          await insertWorkflowEvent(query, { workflow_run_id: id, ...event });
        }
      }
      return { resolved };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_resolve_gate_failed');
    throw new Error(`Failed to resolve approval gate: ${err.message}`);
  }
}

/**
 * Atomically cancel a paused approval gate (compare-and-swap).
 *
 * The reject sibling of resolveApprovalGate for the outcomes that TERMINATE the
 * run (no on_reject prompt, or the attempt cap reached): it flips the run
 * paused→'cancelled' in a SINGLE conditional UPDATE, guarded on the SAME
 * open-gate predicate. Doing it in one statement (instead of stamp-resolution +
 * separate cancelWorkflowRun) means there is never an intermediate
 * resolved-but-not-cancelled state that a failed second write could strand — a
 * reject retry could not self-heal past the fast-path gate guard. No `resolved`
 * marker is written: that marker only matters for the stay-paused rework path,
 * and the rejection reason is preserved in the approval_received event.
 *
 * Writes `workflow_cancelled` itself (#2906) rather than trusting the caller to
 * pass it: this is a terminal status write, and every other terminal writer here
 * (completeWorkflowRun, failWorkflowRun, cancelWorkflowRun, cancelFanOutRun)
 * owns its own lifecycle event. `cancellation` supplies only the event's detail —
 * which gate ended the run, and why — so the event log records the transition
 * even for a caller that only knows about its gate events. Those caller events
 * go in first: the decision precedes the termination it caused.
 *
 * The status flip and every audit event commit in ONE transaction (#2146), so a
 * failed event write rolls the cancellation back rather than terminating the run
 * with no audit trail. Returns `{ resolved }`; `false` means a concurrent
 * resolver already won (the gate is no longer open), so nothing is written.
 */
export async function resolveAndCancelApprovalGate(
  id: string,
  events: GateResolutionEvent[],
  cancellation: WorkflowCancellationEventDetails
): Promise<{ resolved: boolean }> {
  const dialect = getDialect();
  try {
    return await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'cancelled',
             completed_at = ${dialect.now()}
         WHERE id = $1 AND ${unresolvedGateClause()}`,
        [id]
      );
      const resolved = (result.rowCount ?? 0) > 0;
      if (resolved) {
        for (const event of events) {
          await insertWorkflowEvent(query, { workflow_run_id: id, ...event });
        }
        await insertWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'workflow_cancelled',
          step_name: cancellation.step_name,
          data: cancellation.reason === undefined ? undefined : { reason: cancellation.reason },
        });
      }
      return { resolved };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_resolve_cancel_gate_failed');
    throw new Error(`Failed to resolve and cancel approval gate: ${err.message}`);
  }
}

/**
 * Thrown by resumeWorkflowRun when the target run is no longer in a resumable
 * state (already running/terminal, or concurrently resumed). Callers translate
 * this into a user-facing "already being resumed" message instead of leaking
 * the raw internal error string.
 */
export class WorkflowNotResumableError extends Error {
  constructor(
    public readonly runId: string,
    public readonly currentStatus: string
  ) {
    super(
      `Workflow run is not resumable (id: ${runId}, status: ${currentStatus}). ` +
        'It may have already been resumed, completed, or cancelled.'
    );
    this.name = 'WorkflowNotResumableError';
  }
}

export async function createWorkflowRun(data: {
  /**
   * Caller-reserved row id. Supplied when something had to exist at this run's own
   * paths before the row could be written — today that is the workflow-source capture,
   * which is frozen (and, for a container, bind-mounted) before the workflow is even
   * selected. Omitted, the database generates one as it always has.
   */
  id?: string;
  workflow_name: string;
  conversation_id: string;
  codebase_id?: string;
  user_message: string;
  metadata?: Record<string, unknown>;
  working_path?: string;
  parent_conversation_id?: string;
  user_id?: string;
  parent_run_id?: string;
  /** Between-run continuation (#2747) — written once at creation, never on resume. */
  adopted_from_run_id?: string;
}): Promise<WorkflowRun> {
  // Serialize metadata with validation to catch circular references early
  let metadataJson: string;
  try {
    metadataJson = JSON.stringify(data.metadata ?? {});
  } catch (serializeError) {
    const err = serializeError as Error;

    // Check if metadata contains critical context that must not be silently lost
    if (data.metadata && 'github_context' in data.metadata) {
      // Critical context (e.g., GitHub issue/PR details) must not be silently discarded.
      // Failing here surfaces the problem to the user instead of running the workflow
      // with empty context variables ($CONTEXT, $EXTERNAL_CONTEXT, $ISSUE_CONTEXT).
      getLog().error(
        { err, metadataKeys: Object.keys(data.metadata) },
        'db.workflow_run_metadata_serialize_failed'
      );
      throw new Error(
        `Failed to serialize workflow metadata: ${err.message}. ` +
          'Metadata contains github_context which is required for this workflow.'
      );
    }

    // Non-critical metadata: fall back to empty object and log warning
    getLog().warn(
      { err, metadataKeys: data.metadata ? Object.keys(data.metadata) : [] },
      'db.workflow_run_metadata_serialize_fallback'
    );
    metadataJson = '{}';
  }

  try {
    const result = await pool.query<WorkflowRun>(
      data.id === undefined
        ? `INSERT INTO remote_agent_workflow_runs
       (workflow_name, conversation_id, codebase_id, user_message, metadata, working_path, parent_conversation_id, user_id, parent_run_id, adopted_from_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`
        : `INSERT INTO remote_agent_workflow_runs
       (workflow_name, conversation_id, codebase_id, user_message, metadata, working_path, parent_conversation_id, user_id, parent_run_id, adopted_from_run_id, id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        data.workflow_name,
        data.conversation_id,
        data.codebase_id ?? null,
        data.user_message,
        metadataJson,
        data.working_path ?? null,
        data.parent_conversation_id ?? null,
        data.user_id ?? null,
        data.parent_run_id ?? null,
        data.adopted_from_run_id ?? null,
        ...(data.id === undefined ? [] : [data.id]),
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `Failed to create workflow run: INSERT returned no rows (workflow: ${data.workflow_name})`
      );
    }
    return normalizeWorkflowRun(row);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_create_failed');
    throw new Error(`Failed to create workflow run: ${err.message}`);
  }
}

export async function getWorkflowRun(id: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_get_failed');
    throw new Error(`Failed to get workflow run: ${err.message}`);
  }
}

/**
 * Find the workflow run that owns a container isolation environment
 * (`metadata.isolation_env_id === envId`, stamped at run creation for container
 * runs). Used by `isolation cleanup` to decide whether a container is reapable:
 * a paused/running run must NOT be pruned. Returns the newest match, or null when
 * no run references the env (an orphan safe to reap). Dialect-aware JSON extract.
 */
export async function getRunByIsolationEnvId(envId: string): Promise<WorkflowRun | null> {
  const extract =
    getDatabaseType() === 'postgresql'
      ? "metadata->>'isolation_env_id'"
      : "json_extract(metadata, '$.isolation_env_id')";
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE ${extract} = $1
       ORDER BY started_at DESC LIMIT 1`,
      [envId]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, envId }, 'db.workflow_run_get_by_isolation_env_failed');
    throw new Error(`Failed to look up run for isolation env ${envId}: ${err.message}`);
  }
}

/**
 * Find runs in a codebase whose id starts with `idPrefix` (e.g. the 8-char
 * short id shown in listings). Returns up to two matches so callers can detect
 * an ambiguous prefix. Scoped to `codebaseId` in the query, so it never crosses
 * projects. Run ids are UUIDs, so `idPrefix` is rejected unless it's within the
 * UUID charset — that keeps it out of LIKE-wildcard territory (`%` / `_`).
 */
export async function findWorkflowRunsByIdPrefix(
  idPrefix: string,
  codebaseId: string
): Promise<WorkflowRun[]> {
  if (idPrefix.length === 0 || !/^[0-9a-fA-F-]+$/.test(idPrefix)) return [];
  try {
    const result = await pool.query<WorkflowRun>(
      'SELECT * FROM remote_agent_workflow_runs WHERE codebase_id = $1 AND id LIKE $2 LIMIT 2',
      [codebaseId, `${idPrefix}%`]
    );
    return result.rows.map(normalizeWorkflowRun);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_find_by_prefix_failed');
    throw new Error(`Failed to find workflow runs by id prefix: ${err.message}`);
  }
}

export async function getWorkflowRunStatus(id: string): Promise<string | null> {
  try {
    const result = await pool.query<{ status: string }>(
      'SELECT status FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    return result.rows[0]?.status ?? null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_get_status_failed');
    throw new Error(`Failed to get workflow run status: ${err.message}`);
  }
}

export async function getActiveWorkflowRun(conversationId: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE (conversation_id = $1 OR parent_conversation_id = $2) AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
      [conversationId, conversationId]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_get_active_failed');
    throw new Error(`Failed to get active workflow run: ${err.message}`);
  }
}

/**
 * Find a paused workflow run for a conversation (or its parent).
 * Used by the message handler to give the chat agent the open approval gate as
 * context for the turn (#2565).
 * Non-throwing: returns null on DB error so the caller can fall through to normal routing.
 */
export async function getPausedWorkflowRun(conversationId: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE (conversation_id = $1 OR parent_conversation_id = $2) AND status = 'paused'
       ORDER BY started_at DESC LIMIT 1`,
      [conversationId, conversationId]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, conversationId }, 'db.workflow_run_get_paused_failed');
    return null;
  }
}

/**
 * Atomically cancel every RESUMABLE run belonging to a conversation.
 *
 * Used by `/reset` to give the user a real escape hatch: after these are
 * abandoned, the resume lookups find nothing, so the next dispatch starts fresh
 * instead of continuing a stale run.
 *
 * The status set is exactly what the two resume lookups can return —
 * findResumableRunByParentConversation ('failed'/'paused') and
 * getPausedWorkflowRun ('paused'). `pending` and `running` are deliberately NOT
 * matched: neither lookup can ever return them, so leaving them alone cannot
 * cause the stale continuation this exists to prevent, while cancelling them
 * would stop live work that may belong to another process entirely (a CLI run,
 * a webhook-triggered run, a scheduled dispatch).
 *
 * The transaction first locks every existing run in the conversation, including
 * running intermediates. That makes the paused/failed snapshot and the bulk
 * UPDATE one ownership decision: a concurrent resume either wins before the
 * lock or waits until reset has cancelled the run. Locking the running rows too
 * prevents a status-gap run from becoming paused between the snapshot and the
 * UPDATE and being cancelled without appearing in the returned outcomes.
 *
 * SQLite deliberately cannot use UPDATE RETURNING. Returning the locked
 * snapshot and verifying UPDATE rowCount preserves the same contract in both
 * dialects; any phantom or stale-snapshot mismatch throws and rolls back rather
 * than reporting a false all-clear.
 */
export async function cancelResumableRunsForConversation(
  conversationId: string
): Promise<WorkflowRun[]> {
  const dialect = getDialect();
  try {
    return await getDatabase().withTransaction(async query => {
      const snapshot = await query<WorkflowRun>(
        `SELECT * FROM remote_agent_workflow_runs
         WHERE conversation_id = $1 OR parent_conversation_id = $2
         ORDER BY started_at DESC${rowLockClause()}`,
        [conversationId, conversationId]
      );
      const resumable = snapshot.rows.filter(
        run => run.status === 'paused' || run.status === 'failed'
      );
      if (resumable.length === 0) return [];

      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'cancelled', completed_at = ${dialect.now()}
         WHERE (conversation_id = $1 OR parent_conversation_id = $2)
           AND status IN ('paused', 'failed')`,
        [conversationId, conversationId]
      );
      if (result.rowCount !== resumable.length) {
        throw new Error(
          `Resumable run snapshot changed during reset (expected ${String(resumable.length)}, cancelled ${String(result.rowCount)})`
        );
      }
      for (const run of resumable) {
        await insertWorkflowEvent(query, {
          workflow_run_id: run.id,
          event_type: 'workflow_cancelled',
        });
      }
      return resumable.map(run => normalizeWorkflowRun(run));
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, conversationId }, 'db.workflow_run_cancel_resumable_for_conv_failed');
    throw new Error(`Failed to cancel resumable runs for conversation: ${err.message}`);
  }
}

/**
 * Find the workflow run currently holding the lock on `workingPath`.
 *
 * The lock is held by any row in `(running, paused)` or `pending` younger
 * than `STALE_PENDING_AGE_MS` (orphaned pre-creates beyond that window are
 * ignored — they're from crashed or resume-replaced dispatches).
 *
 * When called from a dispatch that already pre-created its own row, pass
 * `self` (`id` + `startedAt`) so:
 *   1. Self is never returned.
 *   2. If two dispatches both have rows, the deterministic older-wins
 *      tiebreaker `(started_at, id)` ensures both agree on which is "first."
 *      The newer dispatch sees the older row and aborts; the older dispatch
 *      sees nothing.
 *
 * `self.excludeRunIds` (#2121 Phase 2) additionally excludes the caller's
 * ancestor run-id chain: a `workflow:` sub-run shares its parent's checkout, so
 * the parent's own running/paused row must not count as a lock against the child.
 *
 * Returns the holding row, or null if the path is free.
 */
export const STALE_PENDING_AGE_MS = 5 * 60 * 1000; // 5 minutes

export async function getActiveWorkflowRunByPath(
  workingPath: string,
  self?: { id: string; startedAt: Date; excludeRunIds?: string[] }
): Promise<WorkflowRun | null> {
  const isPostgres = getDatabaseType() === 'postgresql';
  const stalePendingCutoff = isPostgres
    ? `NOW() - INTERVAL '${String(STALE_PENDING_AGE_MS)} milliseconds'`
    : `datetime('now', '-${String(Math.floor(STALE_PENDING_AGE_MS / 1000))} seconds')`;

  // Build params + clauses dynamically. Self exclusion + tiebreaker travel
  // together — the tiebreaker references both ids and timestamps.
  const params: unknown[] = [workingPath];
  const clauses: string[] = [
    'working_path = $1',
    `(status IN ('running', 'paused') OR (status = 'pending' AND started_at > ${stalePendingCutoff}))`,
  ];
  let selfIdParam: string | undefined;
  if (self !== undefined) {
    params.push(self.id);
    // Captured at push time — the tiebreaker below must reference THIS
    // placeholder, and excludeRunIds params may land in between.
    selfIdParam = `$${String(params.length)}`;
    clauses.push(`id != ${selfIdParam}`);
  }
  // Exclude the caller's ancestor chain (#2121 Phase 2): a `workflow:` sub-run
  // shares the parent's checkout, so the parent's own running/paused row on this
  // path must NOT count as a lock against the child. Each id is a separate
  // placeholder so both dialects bind positionally (no array binding).
  if (self?.excludeRunIds && self.excludeRunIds.length > 0) {
    const placeholders = self.excludeRunIds.map(id => {
      params.push(id);
      return `$${String(params.length)}`;
    });
    clauses.push(`id NOT IN (${placeholders.join(', ')})`);
  }
  if (self !== undefined) {
    // Older-wins tiebreaker. (started_at, id) is a total order so both
    // dispatches always agree on which is "first." Without this, two rows
    // with similar timestamps could mutually see each other and both abort.
    //
    // Serialize Date to ISO string — bun:sqlite rejects Date bindings.
    //
    // Format-aware comparison:
    //   PostgreSQL: started_at is TIMESTAMPTZ; cast the ISO param to
    //     timestamptz so the comparison is chronological, not lexical.
    //   SQLite: started_at is TEXT in "YYYY-MM-DD HH:MM:SS" format. Our
    //     ISO param has "YYYY-MM-DDTHH:MM:SS.mmmZ". Lexical comparison is
    //     WRONG: char 11 is space (0x20) in the column vs T (0x54) in the
    //     param, so every column value lex-sorts before every ISO param —
    //     making `started_at < $param` always TRUE regardless of actual
    //     time. Wrap both sides in datetime() to force chronological
    //     comparison via SQLite's date/time functions.
    params.push(self.startedAt.toISOString());
    const startedAtParam = `$${String(params.length)}`;
    // NOT params.length - 1: excludeRunIds placeholders may sit between the self
    // id and startedAt — a positional back-reference here once pointed the id
    // tiebreak at an ancestor id instead of self (caught by the SQL-shape test).
    // selfIdParam is always set when `self` is (same guard above).
    const idParam = selfIdParam ?? '$2';
    const colExpr = isPostgres ? 'started_at' : 'datetime(started_at)';
    const paramExpr = isPostgres ? `${startedAtParam}::timestamptz` : `datetime(${startedAtParam})`;
    clauses.push(`(${colExpr} < ${paramExpr} OR (${colExpr} = ${paramExpr} AND id < ${idParam}))`);
  }

  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE ${clauses.join(' AND ')}
       ORDER BY started_at ASC, id ASC LIMIT 1`,
      params
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workingPath }, 'db.workflow_run_get_active_by_path_failed');
    throw new Error(`Failed to get active workflow run by path: ${err.message}`);
  }
}

/**
 * Find every run spawned as a child of `parentRunId` (#2121 Phase 2), oldest
 * first. Callers filter further by `metadata.parent_node_id` (a parent may have
 * several `workflow:` nodes) or by status (the abandon cascade cancels
 * non-terminal children).
 */
export async function findChildRuns(parentRunId: string): Promise<WorkflowRun[]> {
  try {
    const result = await pool.query<WorkflowRun>(
      'SELECT * FROM remote_agent_workflow_runs WHERE parent_run_id = $1 ORDER BY started_at ASC',
      [parentRunId]
    );
    return result.rows.map(row => normalizeWorkflowRun(row));
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, parentRunId }, 'db.workflow_run_find_children_failed');
    throw new Error(`Failed to find child workflow runs: ${err.message}`);
  }
}

/**
 * Safety cap on the `parent_run_id` walk. The load-time and runtime cycle guards
 * prevent creating a cyclic run tree, but a hand-edited DB must never hang the
 * walk — deeper than the runtime depth cap (5) so a legitimately deep-but-bounded
 * tree still resolves fully.
 */
const MAX_RUN_ANCESTRY_DEPTH = 32;

/**
 * Walk `parent_run_id` from `runId` up to the root, returning ancestors nearest
 * first (the immediate parent at index 0). Depth-capped and cycle-safe (a
 * repeated id stops the walk). Used by the runtime cycle guard and to build the
 * path-lock exclusion set for a shared-checkout sub-run.
 */
export async function getRunAncestry(runId: string): Promise<WorkflowRun[]> {
  const ancestors: WorkflowRun[] = [];
  const seen = new Set<string>([runId]);
  let current = await getWorkflowRun(runId);
  let depth = 0;
  while (current?.parent_run_id && depth < MAX_RUN_ANCESTRY_DEPTH) {
    const parentId = current.parent_run_id;
    if (seen.has(parentId)) break; // cyclic data — stop rather than loop forever
    const parent = await getWorkflowRun(parentId);
    if (!parent) break; // parent deleted (ON DELETE SET NULL orphan) — chain ends
    ancestors.push(parent);
    seen.add(parentId);
    current = parent;
    depth++;
  }
  return ancestors;
}

export async function getRunningWorkflows(): Promise<
  { id: string; conversation_id: string; workflow_name: string; started_at: string }[]
> {
  try {
    const result = await pool.query<{
      id: string;
      conversation_id: string;
      workflow_name: string;
      started_at: string;
    }>(
      "SELECT id, conversation_id, workflow_name, started_at FROM remote_agent_workflow_runs WHERE status = 'running' ORDER BY started_at ASC LIMIT 100",
      []
    );
    return [...result.rows];
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_runs_get_running_failed');
    return []; // Non-critical: don't break health check
  }
}

export async function findResumableRun(
  workflowName: string,
  workingPath: string
): Promise<WorkflowRun | null> {
  const dialect = getDialect();
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE workflow_name = $1
         AND working_path = $2
         AND ${resumableStatusClause(dialect, 3)}
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
 * Contrast with getActiveWorkflowRunByPath below, which sorts the opposite way (older-wins) —
 * it answers "who took the path lock first", a different question.
 */
export async function findResumableRunByParentConversation(
  workflowName: string,
  parentConversationId: string,
  codebaseId: string
): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
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

export async function resumeWorkflowRun(
  id: string,
  cursor?: WorkflowResumeCursor
): Promise<WorkflowRun> {
  const dialect = getDialect();

  // Split into UPDATE + SELECT to support both PostgreSQL and SQLite
  // (SQLite does not support RETURNING on UPDATE statements)
  // Each phase has its own try/catch to avoid string-sniffing own errors in a shared catch.
  let updateResult: { rowCount: number };
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
    // The CAS also clears `metadata.error` so a run that fails, is resumed, and
    // then completes doesn't keep rendering its old failure (#2329). Because
    // legacy runs may carry their only failure record in metadata (#2348), the error being
    // cleared is first preserved as a `workflow_resumed` event, in the SAME
    // transaction as the clear, so the audit trail can never lose it. The read,
    // the CAS and the event INSERT are one transaction (mirroring
    // resolveApprovalGate, #2146): the row is pinned by rowLockClause() so the
    // value read is the value cleared, and the event is written ONLY by the
    // caller whose CAS matched — a losing concurrent resumer writes nothing.
    // Read-then-UPDATE rather than UPDATE…RETURNING because the SQLite adapter
    // rejects RETURNING on UPDATE and points at exactly this pattern.
    updateResult = await getDatabase().withTransaction(async query => {
      const priorRows = await query<{ status: string; metadata: unknown }>(
        `SELECT status, metadata FROM remote_agent_workflow_runs WHERE id = $1${rowLockClause()}`,
        [id]
      );
      const prior = priorRows.rows[0];
      if (cursor !== undefined) {
        const priorMetadata = normalizeMetadata(prior?.metadata);
        const cursorMatches =
          cursor.kind === 'wait'
            ? prior?.status === 'paused' &&
              isWorkflowWaitContext(priorMetadata.wait) &&
              priorMetadata.wait.kind !== 'attention' &&
              priorMetadata.wait.nodeId === cursor.nodeId &&
              priorMetadata.wait.resumeAt === cursor.resumeAt
            : prior?.status === 'failed' &&
              isScheduledWorkflowResume(priorMetadata.scheduled_resume) &&
              priorMetadata.scheduled_resume.triggeredAt === undefined &&
              priorMetadata.scheduled_resume.attempt === cursor.attempt &&
              priorMetadata.scheduled_resume.resumeAt === cursor.resumeAt;
        if (!cursorMatches) return { rowCount: 0 };
      }
      const clearedError = readMetadataError(prior?.metadata);
      const scheduled = prior?.status === 'failed' ? readScheduledResume(prior.metadata) : null;
      const triggeredAt = scheduled?.triggeredAt === undefined ? new Date().toISOString() : null;
      const metadataPatch = {
        error: null,
        continuation_retry_at: null,
        ...(scheduled !== null && triggeredAt !== null
          ? { scheduled_resume: { ...scheduled, triggeredAt } }
          : {}),
      };

      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'running',
             completed_at = NULL,
             started_at = ${dialect.now()},
             last_activity_at = ${dialect.now()},
             metadata = ${dialect.jsonMerge('metadata', 3)}
         WHERE id = $1 AND ${resumableStatusClause(dialect, 2)}`,
        [id, ORPHAN_RESUME_STALE_DAYS, JSON.stringify(metadataPatch)]
      );

      const rowCount = result.rowCount;
      if (rowCount > 0 && clearedError !== null) {
        // Same `{ error }` payload shape workflow_failed uses, so every consumer
        // that already reads an error off a workflow_* event keeps working.
        await insertWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'workflow_resumed',
          data: { error: clearedError },
        });
      }
      if (rowCount > 0 && scheduled !== null && triggeredAt !== null) {
        await insertWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'quota_resume_triggered',
          data: { attempt: scheduled.attempt, resume_at: scheduled.resumeAt },
        });
      }
      return { rowCount };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_resume_failed');
    throw new Error(`Failed to resume workflow run: ${err.message}`);
  }

  if (updateResult.rowCount === 0) {
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

  let selectResult: Awaited<ReturnType<typeof pool.query<WorkflowRun>>>;
  try {
    selectResult = await pool.query<WorkflowRun>(
      'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_resume_select_failed');
    throw new Error(`Failed to read workflow run after update: ${err.message}`);
  }

  const row = selectResult.rows[0];
  if (!row) {
    getLog().error({ workflowRunId: id }, 'db.workflow_run_resume_vanished');
    throw new Error(`Workflow run vanished after update (id: ${id})`);
  }
  return normalizeWorkflowRun(row);
}

export async function recoverCancelledFanOutRun(id: string): Promise<WorkflowRun> {
  const dialect = getDialect();
  const cancelledReason =
    getDatabaseType() === 'postgresql'
      ? "metadata->>'cancelled_reason'"
      : "json_extract(metadata, '$.cancelled_reason')";
  const metadataWithoutCancelledReason =
    getDatabaseType() === 'postgresql'
      ? "metadata - 'cancelled_reason'"
      : "json_remove(metadata, '$.cancelled_reason')";
  const eventReason =
    getDatabaseType() === 'postgresql' ? "data->>'reason'" : "json_extract(data, '$.reason')";

  try {
    return await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'running',
             completed_at = NULL,
             started_at = ${dialect.now()},
             last_activity_at = ${dialect.now()},
             metadata = ${metadataWithoutCancelledReason}
         WHERE id = $1
           AND status = 'cancelled'
           AND ${cancelledReason} IN ($2, $3, $4)`,
        [id, ...FAN_OUT_CANCEL_REASONS]
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new Error(`Workflow run is not an engine-cancelled fan-out child (id: ${id})`);
      }
      await query(
        `DELETE FROM remote_agent_workflow_events
         WHERE workflow_run_id = $1
           AND event_type = 'workflow_cancelled'
           AND ${eventReason} IN ($2, $3, $4)`,
        [id, ...FAN_OUT_CANCEL_REASONS]
      );
      const recovered = await query<WorkflowRun>(
        'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
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
 * Find the most recent workflow run for a worker platform conversation ID.
 * Joins with conversations table to resolve platform_conversation_id → DB id.
 */
export async function getWorkflowRunByWorkerPlatformId(
  platformConversationId: string
): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT r.* FROM remote_agent_workflow_runs r
       JOIN remote_agent_conversations c ON r.conversation_id = c.id
       WHERE c.platform_conversation_id = $1
       ORDER BY r.started_at DESC LIMIT 1`,
      [platformConversationId]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_get_by_worker_platform_id_failed');
    throw new Error(`Failed to get workflow run by worker platform ID: ${err.message}`);
  }
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
    values.push(JSON.stringify(updates.metadata));
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

export async function completeWorkflowRun(
  id: string,
  completion: { duration_ms: number },
  metadata?: Record<string, unknown>
): Promise<void> {
  const dialect = getDialect();
  let result: Awaited<ReturnType<IDatabase['query']>>;
  try {
    result = await getDatabase().withTransaction(async query => {
      const update = metadata
        ? await query(
            `UPDATE remote_agent_workflow_runs
             SET status = 'completed', completed_at = ${dialect.now()}, metadata = ${dialect.jsonMerge('metadata', 2)}
             WHERE id = $1 AND status = 'running'`,
            [id, JSON.stringify(metadata)]
          )
        : await query(
            `UPDATE remote_agent_workflow_runs
             SET status = 'completed', completed_at = ${dialect.now()}
             WHERE id = $1 AND status = 'running'`,
            [id]
          );
      if ((update.rowCount ?? 0) > 0) {
        await insertWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'workflow_completed',
          data: completion,
        });
      }
      return update;
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_complete_failed');
    throw new Error(`Failed to complete workflow run: ${err.message}`);
  }
  if (result.rowCount === 0) {
    getLog().warn({ workflowRunId: id }, 'db.workflow_run_complete_no_match');
    throw new Error(`Workflow run not found or not in running state (id: ${id})`);
  }
}

/**
 * Mark a run failed.
 *
 * Matches `pending` as well as `running`. A run can fail BEFORE it ever transitions to
 * running — source capture, artifact setup, and credential resolution all happen against
 * a freshly inserted `pending` row — and a `running`-only guard left those rows pending
 * forever: no terminal state, no error recorded, and nothing to tell the operator the run
 * is dead. Both are non-terminal states owned by this process, so failing either is the
 * same decision. Terminal rows still never transition.
 */
export async function failWorkflowRun(
  id: string,
  error: string,
  scheduledResume?: ScheduledWorkflowResume
): Promise<void> {
  const dialect = getDialect();
  const parsedSchedule =
    scheduledResume === undefined
      ? undefined
      : scheduledWorkflowResumeSchema.parse(scheduledResume);
  const metadataWithoutScheduledResume =
    getDatabaseType() === 'postgresql'
      ? "metadata - 'scheduled_resume'"
      : "json_remove(metadata, '$.scheduled_resume')";
  let result: Awaited<ReturnType<IDatabase['query']>>;
  try {
    result = await getDatabase().withTransaction(async query => {
      const update = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'failed', completed_at = ${dialect.now()}, metadata = ${dialect.jsonMerge(metadataWithoutScheduledResume, 2)}
         WHERE id = $1 AND status IN ('running', 'pending')`,
        [
          id,
          JSON.stringify({
            error,
            ...(parsedSchedule !== undefined ? { scheduled_resume: parsedSchedule } : {}),
          }),
        ]
      );
      if ((update.rowCount ?? 0) > 0 && parsedSchedule !== undefined) {
        await insertWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'quota_resume_scheduled',
          data: {
            resume_at: parsedSchedule.resumeAt,
            deadline_at: parsedSchedule.deadlineAt,
            attempt: parsedSchedule.attempt,
            max_attempts: parsedSchedule.maxAttempts,
          },
        });
      }
      if ((update.rowCount ?? 0) > 0) {
        await insertWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'workflow_failed',
          data: { error },
        });
      }
      return update;
    });
  } catch (dbError) {
    const err = dbError as Error;
    getLog().error({ err }, 'db.workflow_run_mark_failed_error');
    throw new Error(`Failed to fail workflow run: ${err.message}`);
  }
  if (result.rowCount === 0) {
    getLog().warn({ workflowRunId: id }, 'db.workflow_run_fail_no_match');
    throw new Error(`Workflow run not found or already terminal (id: ${id})`);
  }
}

export async function cancelWorkflowRun(
  id: string,
  event?: WorkflowCancellationEventDetails
): Promise<{ cancelled: boolean }> {
  const dialect = getDialect();
  let result: Awaited<ReturnType<IDatabase['query']>>;
  try {
    // Guard against re-stamping an already-finished run. Cancelling a run that
    // is 'completed' or 'cancelled' must be a no-op, not a re-write of
    // completed_at / a resurrection of terminal state. 'failed' is intentionally
    // still cancellable (it remains a resumable state, so the user must be able
    // to discard it), and a 'running' run stays cancellable — that is
    // cooperative cancellation, which the executor honors via its between-layer
    // status check (dag-executor).
    result = await getDatabase().withTransaction(async query => {
      const update = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'cancelled', completed_at = ${dialect.now()}
         WHERE id = $1 AND status NOT IN ('completed', 'cancelled')`,
        [id]
      );
      if ((update.rowCount ?? 0) > 0) {
        await insertWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'workflow_cancelled',
          step_name: event?.step_name,
          data: event?.reason === undefined ? undefined : { reason: event.reason },
        });
      }
      return update;
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_cancel_failed');
    throw new Error(`Failed to cancel workflow run: ${err.message}`);
  }
  const cancelled = (result.rowCount ?? 0) > 0;
  if (!cancelled) {
    // Idempotent no-op: the run was already terminal. Returned so callers can
    // report "nothing to cancel" instead of a false "Cancelled" (see #1830 I1).
    // Same info level as the resume CAS-miss signal for consistency (S2).
    getLog().info({ workflowRunId: id }, 'db.workflow_run_cancel_noop');
  }
  return { cancelled };
}

export async function cancelFanOutRun(
  id: string,
  reason: FanOutCancelReason
): Promise<{ cancelled: boolean }> {
  const dialect = getDialect();
  let result: Awaited<ReturnType<IDatabase['query']>>;
  try {
    result = await getDatabase().withTransaction(async query => {
      const update = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'cancelled',
             completed_at = ${dialect.now()},
             metadata = ${dialect.jsonMerge('metadata', 2)}
         WHERE id = $1 AND status NOT IN ('completed', 'cancelled')`,
        [id, JSON.stringify({ cancelled_reason: reason })]
      );
      if ((update.rowCount ?? 0) > 0) {
        await insertWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'workflow_cancelled',
          data: { reason },
        });
      }
      return update;
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id, reason }, 'db.workflow_run_fan_out_cancel_failed');
    throw new Error(`Failed to cancel fan-out run: ${err.message}`);
  }
  const cancelled = (result.rowCount ?? 0) > 0;
  if (!cancelled) {
    getLog().info({ workflowRunId: id, reason }, 'db.workflow_run_fan_out_cancel_noop');
  }
  return { cancelled };
}

/**
 * Pause a running workflow run for human approval.
 * Sets status to 'paused' and stores approval context in metadata.
 * Does NOT set completed_at — the run is not finished.
 *
 * The stored `metadata.approval` is REPLACED with `approvalContext` wholesale
 * (writeApprovalMetadata), never merged into. So a fresh pause stores exactly
 * the keys the caller set — at every depth — and nothing a prior gate of the
 * same run left behind can survive, on either dialect (#2673). Readers treat an
 * absent key exactly like a JSON null (`!= null`, `=== true`, `?? ''`), and
 * unresolvedGateClause's `IS NULL` matches both, so omission is the reset.
 *
 * `extraMetadata` still merges at the TOP level, so run-level keys the pause
 * does not own (e.g. `pending_writeback`, `rejection_count`) are preserved.
 */
export async function pauseWorkflowRun(
  id: string,
  approvalContext: ApprovalContext,
  extraMetadata?: Record<string, unknown>
): Promise<void> {
  try {
    const result = await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'paused', metadata = ${writeApprovalMetadata(2, 3)}
       WHERE id = $1 AND status = 'running'`,
      [
        id,
        // Caller-supplied run-level metadata (e.g. `pending_writeback`) rides the SAME
        // atomic write so there is no window where the run is paused without it (M3).
        JSON.stringify(extraMetadata ?? {}),
        // The complete gate context. JSON.stringify drops undefined, and the write
        // replaces rather than merges, so an optional field the caller left unset is
        // simply absent — no explicit-null reset list to keep in sync.
        JSON.stringify(approvalContext),
      ]
    );
    if (result.rowCount === 0) {
      getLog().warn({ workflowRunId: id }, 'db.workflow_run_pause_no_match');
      throw new Error(`Workflow run not found or not in running state (id: ${id})`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Workflow run not found')) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_pause_failed');
    throw new Error(`Failed to pause workflow run: ${err.message}`);
  }
}

/** Pause a running run on a persisted wait condition. */
export async function pauseWorkflowRunForWait(
  id: string,
  waitContext: WorkflowWaitContext,
  pause: WorkflowWaitPause
): Promise<void> {
  const parsedWaitContext = workflowWaitContextSchema.parse(waitContext);
  try {
    await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'paused', metadata = ${replaceWaitMetadata(2)}
         WHERE id = $1 AND status = 'running'`,
        [id, JSON.stringify(parsedWaitContext)]
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new Error(`Workflow run not found or not in running state (id: ${id})`);
      }
      if (pause.kind === 'started') {
        await insertWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'wait_started',
          step_name: pause.stepName,
          data: {
            kind: parsedWaitContext.kind,
            ...(parsedWaitContext.kind !== 'attention'
              ? { resume_at: parsedWaitContext.resumeAt }
              : {}),
            ...(parsedWaitContext.kind === 'event' ? { event: parsedWaitContext.event } : {}),
          },
        });
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Workflow run not found')) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_wait_pause_failed');
    throw new Error(`Failed to pause workflow run for wait: ${err.message}`);
  }
}

/** Fail the exact attention cursor whose required notification could not be delivered. */
export async function failPausedAttentionWait(
  id: string,
  waitContext: WorkflowAttentionWaitContext,
  error: string
): Promise<{ failed: boolean }> {
  const parsedWaitContext = workflowWaitContextSchema.parse(waitContext);
  if (parsedWaitContext.kind !== 'attention') {
    throw new Error('Only an action-required wait can fail through notification delivery');
  }
  const dialect = getDialect();
  const postgres = getDatabaseType() === 'postgresql';
  const waitField = (field: string): string =>
    postgres ? `metadata->'wait'->>'${field}'` : `json_extract(metadata, '$.wait.${field}')`;
  const params: unknown[] = [
    id,
    JSON.stringify({ error }),
    parsedWaitContext.nodeId,
    parsedWaitContext.waitingSince,
  ];
  const ownerClauses = [`${waitField('owner')} = '${parsedWaitContext.owner}'`];
  if (parsedWaitContext.owner === 'loop_group') {
    params.push(parsedWaitContext.bodyWaitId, parsedWaitContext.iteration);
    const iterationField = postgres
      ? "(metadata->'wait'->>'iteration')::integer"
      : "json_extract(metadata, '$.wait.iteration')";
    ownerClauses.push(`${waitField('bodyWaitId')} = $5`, `${iterationField} = $6`);
  }
  const metadataWithoutScheduledResume = postgres
    ? "metadata - 'scheduled_resume'"
    : "json_remove(metadata, '$.scheduled_resume')";

  try {
    return await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'failed', completed_at = ${dialect.now()}, metadata = ${dialect.jsonMerge(metadataWithoutScheduledResume, 2)}
         WHERE id = $1
           AND status = 'paused'
           AND ${waitField('kind')} = 'attention'
           AND ${waitField('nodeId')} = $3
           AND ${waitField('waitingSince')} = $4
           AND ${ownerClauses.join('\n           AND ')}`,
        params
      );
      const failed = (result.rowCount ?? 0) > 0;
      if (failed) {
        await insertWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'workflow_failed',
          data: { error },
        });
      }
      return { failed };
    });
  } catch (dbError) {
    const err = dbError as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_attention_notification_fail_error');
    throw new Error(`Failed to fail paused attention wait: ${err.message}`);
  }
}

/** Atomically consume one exact wait cursor and persist its completed node snapshot. */
export async function clearWorkflowWaitContext(
  id: string,
  waitContext: WorkflowWaitContext,
  completion: WorkflowWaitCompletion
): Promise<{ cleared: boolean }> {
  const nodeExpr =
    getDatabaseType() === 'postgresql'
      ? "metadata->'wait'->>'nodeId'"
      : "json_extract(metadata, '$.wait.nodeId')";
  const cursorExpr =
    getDatabaseType() === 'postgresql'
      ? `metadata->'wait'->>'${waitContext.kind === 'attention' ? 'waitingSince' : 'resumeAt'}'`
      : `json_extract(metadata, '$.wait.${waitContext.kind === 'attention' ? 'waitingSince' : 'resumeAt'}')`;
  const cursor = waitContext.kind === 'attention' ? waitContext.waitingSince : waitContext.resumeAt;
  const clearWait =
    getDatabaseType() === 'postgresql' ? "metadata - 'wait'" : "json_remove(metadata, '$.wait')";
  try {
    return await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET metadata = ${clearWait}
         WHERE id = $1 AND status = 'running' AND ${nodeExpr} = $2 AND ${cursorExpr} = $3`,
        [id, waitContext.nodeId, cursor]
      );
      if ((result.rowCount ?? 0) === 0) return { cleared: false };
      await insertWorkflowEvent(query, {
        workflow_run_id: id,
        event_type: completion.result.status === 'expired' ? 'wait_expired' : 'wait_completed',
        step_name: completion.stepName,
        data: completion.result,
      });
      await insertWorkflowEvent(query, {
        workflow_run_id: id,
        event_type: 'node_completed',
        step_name: completion.stepName,
        data: {
          type: 'wait',
          duration_ms: completion.result.waited_ms,
          node_output: JSON.stringify(completion.result),
          structured_output: completion.result,
        },
      });
      return { cleared: true };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_wait_clear_failed');
    throw new Error(`Failed to clear workflow wait: ${err.message}`);
  }
}

/** Return a bounded set of time/deadline waits eligible for a resume claim. */
export async function listDueWorkflowContinuations(
  now: Date,
  limit: number
): Promise<WorkflowRun[]> {
  const resumeAt =
    getDatabaseType() === 'postgresql'
      ? "metadata->'wait'->>'resumeAt'"
      : "json_extract(metadata, '$.wait.resumeAt')";
  const signaledAt =
    getDatabaseType() === 'postgresql'
      ? "metadata->'wait'->>'signaledAt'"
      : "json_extract(metadata, '$.wait.signaledAt')";
  const waitKind =
    getDatabaseType() === 'postgresql'
      ? "metadata->'wait'->>'kind'"
      : "json_extract(metadata, '$.wait.kind')";
  const scheduledResumeAt =
    getDatabaseType() === 'postgresql'
      ? "metadata->'scheduled_resume'->>'resumeAt'"
      : "json_extract(metadata, '$.scheduled_resume.resumeAt')";
  const scheduledTriggeredAt =
    getDatabaseType() === 'postgresql'
      ? "metadata->'scheduled_resume'->>'triggeredAt'"
      : "json_extract(metadata, '$.scheduled_resume.triggeredAt')";
  const retryAt =
    getDatabaseType() === 'postgresql'
      ? "metadata->>'continuation_retry_at'"
      : "json_extract(metadata, '$.continuation_retry_at')";
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE (${retryAt} IS NULL OR ${retryAt} <= $1)
         AND ((status = 'paused' AND ${waitKind} IN ('time', 'event')
               AND (${signaledAt} IS NOT NULL OR ${resumeAt} <= $1))
          OR (status = 'failed' AND ${scheduledResumeAt} <= $1 AND ${scheduledTriggeredAt} IS NULL))
       ORDER BY COALESCE(${retryAt}, ${resumeAt}, ${scheduledResumeAt}) ASC
       LIMIT $2`,
      [now.toISOString(), limit]
    );
    return result.rows.map(normalizeWorkflowRun);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_continuation_due_list_failed');
    throw new Error(`Failed to list due workflow continuations: ${err.message}`);
  }
}

/** Back off a continuation that could not acquire execution prerequisites. */
export type WorkflowContinuationCursor = WorkflowResumeCursor;

export async function deferWorkflowContinuation(
  id: string,
  retryAt: string,
  cursor: WorkflowContinuationCursor
): Promise<void> {
  const dialect = getDialect();
  const waitResumeAt =
    getDatabaseType() === 'postgresql'
      ? "metadata->'wait'->>'resumeAt'"
      : "json_extract(metadata, '$.wait.resumeAt')";
  const scheduledResumeAt =
    getDatabaseType() === 'postgresql'
      ? "metadata->'scheduled_resume'->>'resumeAt'"
      : "json_extract(metadata, '$.scheduled_resume.resumeAt')";
  const scheduledTriggeredAt =
    getDatabaseType() === 'postgresql'
      ? "metadata->'scheduled_resume'->>'triggeredAt'"
      : "json_extract(metadata, '$.scheduled_resume.triggeredAt')";
  const waitNodeId =
    getDatabaseType() === 'postgresql'
      ? "metadata->'wait'->>'nodeId'"
      : "json_extract(metadata, '$.wait.nodeId')";
  const scheduledAttempt =
    getDatabaseType() === 'postgresql'
      ? "(metadata->'scheduled_resume'->>'attempt')::integer"
      : "json_extract(metadata, '$.scheduled_resume.attempt')";
  try {
    await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET metadata = ${dialect.jsonMerge('metadata', 2)}
       WHERE id = $1 AND ((status = 'paused' AND ${waitResumeAt} = $3 AND ${waitNodeId} = $4)
         OR (status = 'failed' AND ${scheduledResumeAt} = $3
           AND ${scheduledTriggeredAt} IS NULL AND ${scheduledAttempt} = $5))`,
      [
        id,
        JSON.stringify({ continuation_retry_at: retryAt }),
        cursor.resumeAt,
        cursor.kind === 'wait' ? cursor.nodeId : null,
        cursor.kind === 'quota' ? cursor.attempt : null,
      ]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_continuation_defer_failed');
    throw new Error(`Failed to defer workflow continuation: ${err.message}`);
  }
}

/** Atomically record the signal for one exact paused event wait. */
export async function signalWorkflowWait(
  id: string,
  waitContext: Extract<WorkflowWaitContext, { kind: 'event' }>,
  payload?: unknown
): Promise<{ signaled: boolean }> {
  const parsedWaitContext = workflowWaitContextSchema.parse(waitContext);
  if (parsedWaitContext.kind !== 'event') {
    throw new Error('Cannot signal a non-event workflow wait');
  }
  const eventExpr =
    getDatabaseType() === 'postgresql'
      ? "metadata->'wait'->>'event'"
      : "json_extract(metadata, '$.wait.event')";
  const nodeExpr =
    getDatabaseType() === 'postgresql'
      ? "metadata->'wait'->>'nodeId'"
      : "json_extract(metadata, '$.wait.nodeId')";
  const signaledExpr =
    getDatabaseType() === 'postgresql'
      ? "metadata->'wait'->>'signaledAt'"
      : "json_extract(metadata, '$.wait.signaledAt')";
  const resumeAtExpr =
    getDatabaseType() === 'postgresql'
      ? "metadata->'wait'->>'resumeAt'"
      : "json_extract(metadata, '$.wait.resumeAt')";
  const signaledAt = new Date().toISOString();
  const metadataWrite =
    payload === undefined
      ? getDatabaseType() === 'postgresql'
        ? "jsonb_set(metadata, '{wait,signaledAt}', to_jsonb($5::text), true)"
        : "json_set(metadata, '$.wait.signaledAt', $5)"
      : getDatabaseType() === 'postgresql'
        ? "jsonb_set(jsonb_set(metadata, '{wait,signaledAt}', to_jsonb($5::text), true), '{wait,payload}', $6::jsonb, true)"
        : "json_set(metadata, '$.wait.signaledAt', $5, '$.wait.payload', json($6))";
  try {
    return await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET metadata = ${metadataWrite}
         WHERE id = $1 AND status = 'paused' AND ${eventExpr} = $2
           AND ${nodeExpr} = $3 AND ${resumeAtExpr} = $4
           AND ${signaledExpr} IS NULL AND ${resumeAtExpr} > $5`,
        payload === undefined
          ? [
              id,
              parsedWaitContext.event,
              parsedWaitContext.nodeId,
              parsedWaitContext.resumeAt,
              signaledAt,
            ]
          : [
              id,
              parsedWaitContext.event,
              parsedWaitContext.nodeId,
              parsedWaitContext.resumeAt,
              signaledAt,
              JSON.stringify(payload),
            ]
      );
      const signaled = (result.rowCount ?? 0) > 0;
      if (signaled) {
        await insertWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'wait_signaled',
          step_name: workflowWaitStepName(parsedWaitContext),
          data: {
            event: parsedWaitContext.event,
            ...(payload !== undefined ? { payload } : {}),
          },
        });
      }
      return { signaled };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, workflowRunId: id, event: parsedWaitContext.event },
      'db.workflow_wait_signal_failed'
    );
    throw new Error(`Failed to signal workflow wait: ${err.message}`);
  }
}

/**
 * Atomically CLAIM the container write-back apply before the live root is mutated
 * (R2-F4). A conditional UPDATE that sets `metadata.writeback_apply_claimed = true`
 * only while it is unset — so exactly one resume wins the claim. Returns whether
 * THIS caller won. The caller must apply the overlay only on `claimed === true`, and
 * on apply FAILURE release the claim (`releaseWritebackClaim`) so a `workflow resume`
 * can retry; on a crash AFTER a successful apply the claim stays set, so the next
 * resume finds it claimed and does NOT re-apply (no path applies twice).
 */
export async function claimWriteback(id: string): Promise<{ claimed: boolean }> {
  const dialect = getDialect();
  const extract =
    getDatabaseType() === 'postgresql'
      ? "metadata->>'writeback_apply_claimed'"
      : "json_extract(metadata, '$.writeback_apply_claimed')";
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
 * subsequent `workflow resume` can re-claim and retry. Explicit-null so SQLite's
 * json_patch removes the key (Postgres `||` sets JSON null); `claimWriteback`'s
 * `IS NULL` check treats both as unclaimed. Best-effort — a failure here leaves the
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

export type {
  DashboardWorkflowRun,
  ListDashboardRunsOptions,
  DashboardRunsResult,
} from '../schemas/workflow-run';

function dashboardStatuses(
  status: NonNullable<ListDashboardRunsOptions['status']>
): WorkflowRunStatus[] {
  return [...new Set(Array.isArray(status) ? status : [status])];
}

/**
 * Build WHERE clauses shared between the list and count queries.
 * Returns the clauses array and values array (mutated in place).
 */
function buildDashboardWhereClauses(
  options: ListDashboardRunsOptions | undefined,
  values: unknown[]
): string[] {
  const whereClauses: string[] = [];

  if (options?.status) {
    const placeholders = dashboardStatuses(options.status).map(status => {
      values.push(status);
      return `$${String(values.length)}`;
    });
    whereClauses.push(`r.status IN (${placeholders.join(', ')})`);
  }
  if (options?.codebaseId) {
    values.push(options.codebaseId);
    whereClauses.push(`r.codebase_id = $${String(values.length)}`);
  }
  if (options?.search) {
    const pattern = `%${options.search}%`;
    values.push(pattern, pattern);
    whereClauses.push(
      `(r.workflow_name LIKE $${String(values.length - 1)} OR r.user_message LIKE $${String(values.length)})`
    );
  }
  if (options?.after) {
    values.push(options.after);
    whereClauses.push(`r.started_at >= $${String(values.length)}`);
  }
  if (options?.before) {
    values.push(options.before);
    whereClauses.push(`r.started_at < $${String(values.length)}`);
  }

  return whereClauses;
}

/**
 * Returns a SQL fragment to extract and cast an integer from a JSON data column.
 * Handles SQLite (`json_extract`) and PostgreSQL (`->>`/`::INTEGER`) dialects.
 */
function jsonIntExtract(col: string, key: string): string {
  return getDatabaseType() === 'postgresql'
    ? `(${col}->>'${key}')::INTEGER`
    : `CAST(json_extract(${col}, '$.${key}') AS INTEGER)`;
}

/**
 * List workflow runs with enriched JOINs for the dashboard Command Center.
 * Supports server-side search, status/date filtering, and offset-based pagination.
 * Returns runs, total matching count, and per-status counts for the filter bar.
 */
export async function listDashboardRuns(
  options?: ListDashboardRunsOptions
): Promise<DashboardRunsResult> {
  // Build shared WHERE for both queries
  const listValues: unknown[] = [];
  const whereClauses = buildDashboardWhereClauses(options, listValues);

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  listValues.push(limit);
  const limitParam = `$${String(listValues.length)}`;
  listValues.push(offset);
  const offsetParam = `$${String(listValues.length)}`;

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Build count query with the same base filters MINUS the status filter.
  // This lets us compute per-status counts across the full filtered set.
  const countValues: unknown[] = [];
  const countWhereClauses = buildDashboardWhereClauses(
    options ? { ...options, status: undefined } : undefined,
    countValues
  );
  const countWhereStr =
    countWhereClauses.length > 0 ? `WHERE ${countWhereClauses.join(' AND ')}` : '';

  try {
    const [listResult, countResult] = await Promise.all([
      pool.query<
        Omit<
          DashboardWorkflowRun,
          'active_nodes' | 'current_step_name' | 'current_step_status' | 'total_steps'
        >
      >(
        `SELECT r.*,
                c.platform_type,
                c.platform_conversation_id AS worker_platform_id,
                pc.platform_conversation_id AS parent_platform_id,
                cb.name AS codebase_name,
                (SELECT COUNT(*) FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_completed') AS agents_completed,
                (SELECT COUNT(*) FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_failed') AS agents_failed,
                (SELECT ${jsonIntExtract('e.data', 'totalAgents')}
                 FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_started'
                 ORDER BY e.created_at DESC LIMIT 1) AS agents_total
         FROM remote_agent_workflow_runs r
         LEFT JOIN remote_agent_conversations c ON r.conversation_id = c.id
         LEFT JOIN remote_agent_conversations pc ON r.parent_conversation_id = pc.id
         LEFT JOIN remote_agent_codebases cb ON r.codebase_id = cb.id
         ${whereStr}
         ORDER BY r.started_at DESC
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        listValues
      ),
      pool.query<{ status: string; cnt: string }>(
        `SELECT r.status, COUNT(*) AS cnt
         FROM remote_agent_workflow_runs r
         ${countWhereStr}
         GROUP BY r.status`,
        countValues
      ),
    ]);

    const counts = {
      all: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      pending: 0,
      paused: 0,
    };
    for (const row of countResult.rows) {
      const n = Number(row.cnt);
      counts.all += n;
      if (row.status in counts) {
        counts[row.status as keyof Omit<typeof counts, 'all'>] = n;
      }
    }

    // Total for the current filter (with status applied)
    const total = options?.status
      ? dashboardStatuses(options.status).reduce((sum, status) => sum + counts[status], 0)
      : counts.all;

    const activeByRun = await listActiveWorkflowNodeIds(listResult.rows.map(run => run.id));
    const runs = listResult.rows.map(run => {
      const activeNodes = activeByRun.get(run.id) ?? [];
      const hasSingleActiveNode = activeNodes.length === 1;
      return normalizeWorkflowRun({
        ...run,
        active_nodes: activeNodes,
        current_step_name: hasSingleActiveNode ? (activeNodes[0] ?? null) : null,
        current_step_status: hasSingleActiveNode ? ('running' as const) : null,
        total_steps: null,
      });
    });

    return { runs, total, counts };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'list_dashboard_runs_failed');
    throw new Error(`Failed to list dashboard runs: ${err.message}`);
  }
}

/**
 * List workflow runs with optional filters.
 */
export async function listWorkflowRuns(options?: {
  conversationId?: string;
  status?: WorkflowRunStatus | WorkflowRunStatus[];
  limit?: number;
  codebaseId?: string;
  /**
   * Non-enforcing "mine" filter: when set, restrict to runs attributed to this
   * user (`user_id = $N`). Absent → all runs (default visibility stays open).
   */
  userId?: string;
}): Promise<WorkflowRun[]> {
  const whereClauses: string[] = [];
  const values: unknown[] = [];

  if (options?.conversationId) {
    values.push(options.conversationId);
    whereClauses.push(`conversation_id = $${String(values.length)}`);
  }
  if (options?.userId) {
    values.push(options.userId);
    whereClauses.push(`user_id = $${String(values.length)}`);
  }
  if (options?.status !== undefined) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    if (statuses.length > 0) {
      const startIdx = values.length + 1;
      values.push(...statuses);
      const placeholders = statuses.map((_, i) => `$${String(startIdx + i)}`).join(', ');
      whereClauses.push(`status IN (${placeholders})`);
    }
  }
  if (options?.codebaseId) {
    values.push(options.codebaseId);
    whereClauses.push(`remote_agent_workflow_runs.codebase_id = $${String(values.length)}`);
  }

  const limit = options?.limit ?? 50;
  values.push(limit);
  const limitParam = `$${String(values.length)}`;

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs ${whereStr} ORDER BY started_at DESC LIMIT ${limitParam}`,
      values
    );
    return result.rows.map(normalizeWorkflowRun);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_list_failed');
    throw new Error(`Failed to list workflow runs: ${err.message}`);
  }
}

/**
 * The one WHERE fragment both ownerless-run queries are built from, so the
 * preview count and the UPDATE cannot describe different sets. Appends to
 * `params` and returns the SQL.
 *
 * A run is scoped by the conversation it is answerable to: its dispatching
 * parent when it has one, else its own conversation (a CLI run has no parent —
 * `conversation_id` is the only conversation it has). That mirrors how
 * `authorizeRunAction` resolves an owner, so claiming makes exactly the runs
 * actionable that the fallback would otherwise leave stranded.
 *
 * `user_id IS NULL` is the invariant: a run already attributed to a real user
 * can never be moved to another one. The answerable conversation must be unowned
 * or already owned by the claiming user: the conversation claim runs first and
 * takes the unowned ones, so this is what stops a second operator's claim from
 * attaching a run to themselves while its conversation belongs to someone else.
 */
function ownerlessRunWhere(
  ownerId: string,
  filter: OwnerlessClaimFilter,
  params: unknown[]
): string {
  params.push(ownerId);
  const ownerParam = `$${String(params.length)}`;
  const platforms = filter.platformTypes.map(platform => {
    params.push(platform);
    return `$${String(params.length)}`;
  });
  let sql =
    'user_id IS NULL AND COALESCE(parent_conversation_id, conversation_id) IN ' +
    `(SELECT id FROM remote_agent_conversations WHERE platform_type IN (${platforms.join(', ')}) ` +
    `AND (user_id IS NULL OR user_id = ${ownerParam}))`;
  if (filter.before) {
    params.push(toDbTimestampParam(filter.before));
    sql += ` AND started_at < $${String(params.length)}`;
  }
  return sql;
}

/**
 * How many workflow runs an ownership claim with this filter would take.
 * Drives the preview and `--dry-run`, which must not write.
 */
export async function countOwnerlessRuns(
  userId: string,
  filter: OwnerlessClaimFilter
): Promise<number> {
  // Fail closed: no platform selected means no run selected.
  if (filter.platformTypes.length === 0) return 0;

  const params: unknown[] = [];
  const where = ownerlessRunWhere(userId, filter, params);
  try {
    const result = await pool.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM remote_agent_workflow_runs WHERE ${where}`,
      params
    );
    return Number(result.rows[0]?.count ?? 0);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.ownerless_run_count_failed');
    throw new Error(`Failed to count unowned workflow runs: ${err.message}`);
  }
}

/**
 * Attach every unattributed workflow run matching the filter to `userId`,
 * returning how many rows moved.
 *
 * Runs are claimed alongside conversations because run *actions* are owned too
 * (#3135 Phase 4): a run whose `user_id` is null and whose parent conversation
 * has no owner can be approved, resumed, or cancelled by nobody.
 */
export async function claimOwnerlessRuns(
  userId: string,
  filter: OwnerlessClaimFilter
): Promise<number> {
  if (filter.platformTypes.length === 0) return 0;

  const params: unknown[] = [];
  const where = ownerlessRunWhere(userId, filter, params);
  try {
    const result = await pool.query(
      `UPDATE remote_agent_workflow_runs SET user_id = $1 WHERE ${where}`,
      params
    );
    return result.rowCount ?? 0;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.ownerless_run_claim_failed');
    throw new Error(`Failed to claim unowned workflow runs: ${err.message}`);
  }
}

/**
 * The open-work inbox (#2747): runs that ended with work on the table. Status-
 * derived v1 semantics — terminal AND failed AND no run has adopted or
 * superseded it (the NOT EXISTS closes the row behaviorally when a successor
 * claims it). Deletion is hard in this store, so "not deleted" holds by
 * construction. Paused/waiting/cancelled runs are excluded by design: they are
 * live or already judged.
 */
export async function findOpenWorkRuns(options?: {
  codebaseId?: string;
  limit?: number;
}): Promise<WorkflowRun[]> {
  const values: unknown[] = [];
  let codebaseClause = '';
  if (options?.codebaseId) {
    values.push(options.codebaseId);
    codebaseClause = `AND codebase_id = $${String(values.length)}`;
  }
  const limit = options?.limit ?? 50;
  values.push(limit);
  const limitParam = `$${String(values.length)}`;

  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs r
       WHERE r.status = 'failed'
         ${codebaseClause}
         AND NOT EXISTS (
           SELECT 1 FROM remote_agent_workflow_runs a
           WHERE a.adopted_from_run_id = r.id
         )
       ORDER BY r.started_at DESC
       LIMIT ${limitParam}`,
      values
    );
    return result.rows.map(normalizeWorkflowRun);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_open_work_list_failed');
    throw new Error(`Failed to list open workflow runs: ${err.message}`);
  }
}

/**
 * Runs that adopted or superseded `runId` (#2747) — the reverse direction of
 * `adopted_from_run_id`, same column, no second column. Newest first.
 */
export async function findAdoptingRuns(runId: string): Promise<WorkflowRun[]> {
  try {
    const result = await pool.query<WorkflowRun>(
      'SELECT * FROM remote_agent_workflow_runs WHERE adopted_from_run_id = $1 ORDER BY started_at DESC',
      [runId]
    );
    return result.rows.map(normalizeWorkflowRun);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'db.workflow_run_adopters_lookup_failed');
    throw new Error(`Failed to find adopting runs: ${err.message}`);
  }
}

/**
 * Update parent_conversation_id on a workflow run.
 * Non-critical — logs error but does not throw.
 */
export async function updateWorkflowRunParent(
  runId: string,
  parentConversationId: string
): Promise<void> {
  try {
    await pool.query(
      'UPDATE remote_agent_workflow_runs SET parent_conversation_id = $1 WHERE id = $2',
      [parentConversationId, runId]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId, parentConversationId }, 'db.workflow_run_update_parent_failed');
    // Non-critical — don't throw
  }
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
  // Validate olderThanDays is a safe non-negative integer before SQL interpolation.
  // The dialect has no "date subtract" helper, so we must interpolate — but only after validation.
  if (!Number.isInteger(olderThanDays) || olderThanDays < 0) {
    throw new Error(
      `Invalid olderThanDays: ${String(olderThanDays)} (must be a non-negative integer)`
    );
  }
  const cutoff =
    getDatabaseType() === 'postgresql'
      ? `NOW() - INTERVAL '${String(olderThanDays)} days'`
      : `datetime('now', '-${String(olderThanDays)} days')`;
  try {
    await pool.query('BEGIN', []);
    // Delete events first (FK reference)
    await pool.query(
      `DELETE FROM remote_agent_workflow_events WHERE workflow_run_id IN (
        SELECT id FROM remote_agent_workflow_runs
        WHERE status IN ('completed', 'failed', 'cancelled')
          AND started_at < ${cutoff}
      )`,
      []
    );
    const result = await pool.query(
      `DELETE FROM remote_agent_workflow_runs
       WHERE status IN ('completed', 'failed', 'cancelled')
         AND started_at < ${cutoff}`,
      []
    );
    await pool.query('COMMIT', []);
    return { count: result.rowCount ?? 0 };
  } catch (error) {
    await rollback();
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
    await pool.query('BEGIN', []);
    // Guard: verify run exists and is terminal before deleting
    const check = await pool.query<{ status: string }>(
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
    await pool.query('DELETE FROM remote_agent_workflow_events WHERE workflow_run_id = $1', [id]);
    await pool.query('DELETE FROM remote_agent_workflow_runs WHERE id = $1', [id]);
    await pool.query('COMMIT', []);
  } catch (error) {
    await rollback();
    if (error instanceof WorkflowRunGuardError) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_delete_failed');
    throw new Error(`Failed to delete workflow run: ${err.message}`);
  }
}
