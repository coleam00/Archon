/**
 * Lifecycle transitions of workflow runs: creating the row, claiming a pending
 * run, and the terminal completed, failed and cancelled writes with their
 * durable events. Re-exported from the `./workflows` entry.
 */
import type { IWorkflowStore } from '@archon/workflows/store';
import { WORKTREE_REMOVAL_OWNER } from '@archon/isolation/types';
import {
  sourceReleaseMetadata,
  DETACHED_LAUNCH_METADATA_KEY,
  EXECUTION_CLAIM_METADATA_KEY,
  sourceReleasedEvent,
  type FanOutCancelReason,
  type SourceReleaseWrite,
  type WorkflowCancellationEventDetails,
} from '@archon/workflows/store';
import { RUN_AI_CONFIGURATION_METADATA_KEY } from '@archon/workflows/schemas/run-ai-configuration';
import { PAUSE_CAUSE_METADATA_KEY } from '@archon/workflows/schemas/pause-cause';
import {
  CANCELLATION_NOOP_WORKFLOW_STATUSES,
  RUN_STOP_REASON_METADATA_KEY,
  TERMINAL_WORKFLOW_STATUSES,
  workflowRunOriginSchema,
  validateWorkflowWaitMetadata,
  type WorkflowRun,
  type WorkflowRunOrigin,
} from '@archon/workflows/schemas/workflow-run';
import type { IDatabase } from './adapters/types';
import { getDatabase, getDialect } from './connection';
import { lockConversationOwnership } from './conversation-ownership';
import type { TransactionQuery } from './resource-slots';
import { insertWorkflowEvent } from './workflow-events';
import { assertPublicConversation, ensureWorkflowOriginAnchor } from './workflow-origin-anchor';
import { normalizeWorkflowRun, type WorkflowRunRow } from './workflow-run-normalization';
import { getWorkflowRunStatus } from './workflow-run-reads';
import { getLog } from './workflow-run-shared';
import {
  insertTerminalWorkflowEvent,
  observeRunTerminalArtifacts,
  observeTerminalArtifacts,
} from './workflow-terminal-event';
import { reportRunTerminal } from './workflow-terminal-telemetry';

export type WorkflowRunInsert = Parameters<IWorkflowStore['createWorkflowRun']>[0];

export async function insertWorkflowRun(
  query: TransactionQuery,
  data: WorkflowRunInsert
): Promise<WorkflowRun> {
  validateWorkflowWaitMetadata(data.metadata);
  const metadataJson = serializeRunMetadata(data.metadata);
  const origin = workflowRunOriginSchema.parse(data.origin ?? {});
  if (origin.conversationId) assertPublicConversation(origin.conversationId);
  if (origin.parentConversationId) assertPublicConversation(origin.parentConversationId);
  const physicalConversationId = origin.conversationId ?? (await ensureWorkflowOriginAnchor(query));
  try {
    // Lock the origin's conversations so a concurrent project detach cannot interleave.
    // An origin-free run has none to lock: its hidden anchor never has a project, so a
    // detach always refuses it.
    await lockConversationOwnership(query, [
      ...(origin.conversationId ? [origin.conversationId] : []),
      ...(origin.parentConversationId ? [origin.parentConversationId] : []),
    ]);
    const row = await insertRunRow(query, data, metadataJson, physicalConversationId, origin);
    return normalizeWorkflowRun(row);
  } catch (error) {
    throw new Error(`Failed to create workflow run: ${(error as Error).message}`);
  }
}

/** Serializes run metadata, refusing only when it carries launch policy a resume needs. */
function serializeRunMetadata(metadata: WorkflowRunInsert['metadata']): string {
  try {
    return JSON.stringify(metadata ?? {});
  } catch (serializeError) {
    const err = serializeError as Error;

    // Losing launch policy would silently change execution on the next resume.
    if (
      metadata &&
      ('github_context' in metadata || RUN_AI_CONFIGURATION_METADATA_KEY in metadata)
    ) {
      getLog().error(
        { err, metadataKeys: Object.keys(metadata) },
        'db.workflow_run_metadata_serialize_failed'
      );
      throw new Error(
        `Failed to serialize workflow metadata: ${err.message}. ` +
          'Metadata contains required workflow context or AI configuration.'
      );
    }

    // Non-critical metadata: fall back to empty object and log warning
    getLog().warn(
      { err, metadataKeys: metadata ? Object.keys(metadata) : [] },
      'db.workflow_run_metadata_serialize_fallback'
    );
    return '{}';
  }
}

async function insertRunRow(
  query: TransactionQuery,
  data: WorkflowRunInsert,
  metadataJson: string,
  physicalConversationId: string,
  origin: WorkflowRunOrigin
): Promise<WorkflowRunRow> {
  const result = await query<WorkflowRunRow>(
    data.id === undefined
      ? `INSERT INTO remote_agent_workflow_runs
       (workflow_name, conversation_id, codebase_id, user_message, metadata, working_path, parent_conversation_id, user_id, parent_run_id, adopted_from_run_id, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *, CAST(origin AS TEXT) AS origin`
      : `INSERT INTO remote_agent_workflow_runs
       (workflow_name, conversation_id, codebase_id, user_message, metadata, working_path, parent_conversation_id, user_id, parent_run_id, adopted_from_run_id, origin, id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *, CAST(origin AS TEXT) AS origin`,
    [
      data.workflow_name,
      physicalConversationId,
      data.codebase_id ?? null,
      data.user_message,
      metadataJson,
      data.working_path ?? null,
      origin.parentConversationId ?? null,
      origin.userId ?? null,
      data.parent_run_id ?? null,
      data.adopted_from_run_id ?? null,
      JSON.stringify(origin),
      ...(data.id === undefined ? [] : [data.id]),
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `Failed to create workflow run: INSERT returned no rows (workflow: ${data.workflow_name})`
    );
  }
  return row;
}

export async function createWorkflowRun(data: WorkflowRunInsert): Promise<WorkflowRun> {
  try {
    return await getDatabase().withTransaction(query => insertWorkflowRun(query, data));
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_create_failed');
    throw err;
  }
}

/**
 * A run whose checkout belongs only to destroyed worktree records, or to any record
 * being removed, cannot start. Cleanup's removal claim commits before its final
 * claimant check, so a run that reused the checkout too late to be seen, even through
 * another registration of the same path, fails here instead of starting in a checkout
 * that is being removed.
 *
 * `workingPath` is stamped by the claim itself on a row created without one
 * (`run --detach`), so the check and the claimant lookup see the checkout the
 * run is about to use. An existing path is never replaced.
 */
export async function claimPendingWorkflowRun(
  id: string,
  workingPath?: string
): Promise<WorkflowRun | null> {
  return getDatabase().withTransaction(async query => {
    const claimed = await query(
      `UPDATE remote_agent_workflow_runs
          SET status = 'running', last_activity_at = ${getDialect().now()},
              working_path = COALESCE(working_path, CAST($2 AS TEXT))
        WHERE id = $1 AND status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM remote_agent_isolation_environments e
             WHERE e.provider = 'worktree'
               AND e.codebase_id = remote_agent_workflow_runs.codebase_id
               AND e.working_path = COALESCE(remote_agent_workflow_runs.working_path, CAST($2 AS TEXT))
             GROUP BY e.working_path
            HAVING SUM(CASE WHEN e.status = 'active' THEN 1 ELSE 0 END) = 0
                OR SUM(CASE WHEN e.status = 'active' AND ${getDialect().jsonText('e.metadata', WORKTREE_REMOVAL_OWNER)} IS NOT NULL THEN 1 ELSE 0 END) > 0
          )
          AND (
            NOT EXISTS (SELECT 1 FROM remote_agent_resource_start_requests q WHERE q.id = $1)
            OR EXISTS (
              SELECT 1
                FROM remote_agent_resource_start_requests q
                JOIN remote_agent_resource_slot_holders h
                  ON h.resource_key = q.resource_key AND h.holder_kind = 'run' AND h.holder_id = CAST(q.id AS TEXT)
               WHERE q.id = $1 AND q.status = 'admitted'
            )
          )`,
      [id, workingPath ?? null]
    );
    if (claimed.rowCount !== 1) return null;
    const selected = await query<WorkflowRunRow>(
      'SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    return selected.rows[0] ? normalizeWorkflowRun(selected.rows[0]) : null;
  });
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
  conversationId: string,
  assertMayCancel?: (runs: WorkflowRun[]) => void
): Promise<WorkflowRun[]> {
  const dialect = getDialect();
  let cancelledRuns: WorkflowRun[];
  let authorizationRefused = false;
  try {
    const candidates = await getDatabase().query<Pick<WorkflowRun, 'id' | 'output_root'>>(
      `SELECT id, output_root FROM remote_agent_workflow_runs
       WHERE (conversation_id = $1 OR parent_conversation_id = $2)
         AND status IN ('paused', 'failed')`,
      [conversationId, conversationId]
    );
    const artifacts = await observeTerminalArtifacts(candidates.rows);
    cancelledRuns = await getDatabase().withTransaction(async query => {
      const snapshot = await query<WorkflowRunRow>(
        `SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs
         WHERE conversation_id = $1 OR parent_conversation_id = $2
         ORDER BY started_at DESC${dialect.rowLock()}`,
        [conversationId, conversationId]
      );
      const resumable = snapshot.rows.filter(
        run => run.status === 'paused' || run.status === 'failed'
      );
      try {
        assertMayCancel?.(resumable.map(run => normalizeWorkflowRun(run)));
      } catch (error) {
        authorizationRefused = true;
        throw error;
      }
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
        await insertTerminalWorkflowEvent(
          query,
          {
            workflow_run_id: run.id,
            event_type: 'workflow_cancelled',
            data: { cancel_reason: 'conversation_reset' },
          },
          artifacts
        );
      }
      return resumable.map(run => normalizeWorkflowRun(run));
    });
  } catch (error) {
    const err = error as Error;
    if (authorizationRefused) throw error;
    getLog().error({ err, conversationId }, 'db.workflow_run_cancel_resumable_for_conv_failed');
    throw new Error(`Failed to cancel resumable runs for conversation: ${err.message}`);
  }
  for (const run of cancelledRuns) await reportRunTerminal(run.id);
  return cancelledRuns;
}

export async function completeWorkflowRun(
  id: string,
  completion: { duration_ms: number },
  metadata?: Record<string, unknown>
): Promise<void> {
  validateWorkflowWaitMetadata(metadata);
  const dialect = getDialect();
  let result: Awaited<ReturnType<IDatabase['query']>>;
  try {
    const artifacts = await observeRunTerminalArtifacts(id);
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
        await insertTerminalWorkflowEvent(
          query,
          {
            workflow_run_id: id,
            event_type: 'workflow_completed',
            data: completion,
          },
          artifacts
        );
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
  await reportRunTerminal(id);
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
 *
 * `exitReason` is the run's categorical cause, recorded on the terminal event and — with
 * `signal`, when a signal arriving at the owning process is what stopped the run — on the
 * run row as `metadata.stop_reason` for the operator surfaces to read (#3479).
 */
export async function failWorkflowRun(
  id: string,
  error: string,
  options: NonNullable<Parameters<IWorkflowStore['failWorkflowRun']>[2]> = {}
): Promise<{ failed: boolean }> {
  const { exitReason, signal, pendingLaunchToken, expectedExecutionClaim } = options;
  const dialect = getDialect();
  // Both keys belong to ONE failure: the stop reason is written wholesale below, and a
  // quota schedule an older binary wrote with a previous failure is spent once the run
  // ran again. A previous failure's copy is removed before the merge rather than merged
  // into. Postgres `||` replaces a nested object while SQLite's json_patch recurses into
  // it, and a run can reach 'running' again carrying a stale stop reason (resume, or a
  // fan-out cancel recovery) — under json_patch alone that would leave a previous signal
  // attached to a new reason, the #2673 defect through the same mechanism.
  // A failed run is not paused at anything, so its last pause cause goes too.
  const metadataWithoutPriorFailure = dialect.jsonRemove(
    'metadata',
    'scheduled_resume',
    RUN_STOP_REASON_METADATA_KEY,
    PAUSE_CAUSE_METADATA_KEY
  );
  const claimPredicate =
    expectedExecutionClaim === undefined
      ? ''
      : ` AND status = 'running' AND ${dialect.jsonText('metadata', EXECUTION_CLAIM_METADATA_KEY)} ${
          expectedExecutionClaim === null
            ? 'IS NULL'
            : `= $${pendingLaunchToken !== undefined ? 4 : 3}`
        }`;
  let result: Awaited<ReturnType<IDatabase['query']>>;
  try {
    const artifacts = await observeRunTerminalArtifacts(id);
    result = await getDatabase().withTransaction(async query => {
      const update = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'failed', completed_at = ${dialect.now()}, metadata = ${dialect.jsonMerge(metadataWithoutPriorFailure, 2)}
         WHERE id = $1 AND ${
           pendingLaunchToken !== undefined
             ? `status = 'pending' AND ${dialect.jsonText('metadata', DETACHED_LAUNCH_METADATA_KEY)} = $3`
             : "status IN ('running', 'pending')"
         }${claimPredicate}`,
        [
          id,
          JSON.stringify({
            error,
            ...(exitReason !== undefined
              ? {
                  [RUN_STOP_REASON_METADATA_KEY]: {
                    reason: exitReason,
                    ...(signal !== undefined ? { signal } : {}),
                  },
                }
              : {}),
          }),
          ...(pendingLaunchToken !== undefined ? [pendingLaunchToken] : []),
          ...(typeof expectedExecutionClaim === 'string' ? [expectedExecutionClaim] : []),
        ]
      );
      if ((update.rowCount ?? 0) > 0) {
        await insertTerminalWorkflowEvent(
          query,
          {
            workflow_run_id: id,
            event_type: 'workflow_failed',
            data: { error, ...(exitReason !== undefined ? { exit_reason: exitReason } : {}) },
          },
          artifacts
        );
      }
      return update;
    });
  } catch (dbError) {
    const err = dbError as Error;
    getLog().error({ err }, 'db.workflow_run_mark_failed_error');
    throw new Error(`Failed to fail workflow run: ${err.message}`);
  }
  if (result.rowCount === 0) {
    if (pendingLaunchToken !== undefined || expectedExecutionClaim !== undefined)
      return { failed: false };
    const status = await getWorkflowRunStatus(id);
    if (TERMINAL_WORKFLOW_STATUSES.some(terminal => terminal === status)) return { failed: false };
    getLog().warn({ workflowRunId: id }, 'db.workflow_run_fail_no_match');
    throw new Error(`Workflow run not found or not in pending/running state (id: ${id})`);
  }
  await reportRunTerminal(id);
  return { failed: true };
}

export async function cancelWorkflowRun(
  id: string,
  event?: WorkflowCancellationEventDetails
): Promise<{ cancelled: boolean }> {
  const dialect = getDialect();
  let result: Awaited<ReturnType<IDatabase['query']>>;
  try {
    const artifacts = await observeRunTerminalArtifacts(id);
    result = await getDatabase().withTransaction(async query => {
      const update = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'cancelled', completed_at = ${dialect.now()}
         WHERE id = $1 AND status NOT IN (${CANCELLATION_NOOP_WORKFLOW_STATUSES.map((_, index) => `$${index + 2}`).join(', ')})`,
        [id, ...CANCELLATION_NOOP_WORKFLOW_STATUSES]
      );
      if ((update.rowCount ?? 0) > 0) {
        const { step_name, ...data } = event ?? {};
        await insertTerminalWorkflowEvent(
          query,
          {
            workflow_run_id: id,
            event_type: 'workflow_cancelled',
            step_name,
            data,
          },
          artifacts
        );
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
  } else {
    await reportRunTerminal(id);
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
    const artifacts = await observeRunTerminalArtifacts(id);
    result = await getDatabase().withTransaction(async query => {
      const update = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'cancelled',
             completed_at = ${dialect.now()},
             metadata = ${dialect.jsonMerge('metadata', 2)}
         WHERE id = $1 AND status NOT IN (${CANCELLATION_NOOP_WORKFLOW_STATUSES.map((_, index) => `$${index + 3}`).join(', ')})`,
        [id, JSON.stringify({ cancelled_reason: reason }), ...CANCELLATION_NOOP_WORKFLOW_STATUSES]
      );
      if ((update.rowCount ?? 0) > 0) {
        await insertTerminalWorkflowEvent(
          query,
          {
            workflow_run_id: id,
            event_type: 'workflow_cancelled',
            data: { reason, cancel_reason: 'fan_out' },
          },
          artifacts
        );
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
  } else {
    await reportRunTerminal(id);
  }
  return { cancelled };
}

/** Release a running run whose source this host could not read (see `IWorkflowStore`). */
export async function releaseRunForUnreadableSource(
  id: string,
  release: SourceReleaseWrite,
  beforePublish?: () => Promise<void>
): Promise<{ released: boolean }> {
  const dialect = getDialect();
  try {
    return await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'paused', last_activity_at = ${dialect.now()},
             metadata = ${dialect.jsonMerge('metadata', 2)}
         WHERE id = $1 AND status = 'running'
           AND ${dialect.jsonText('metadata', EXECUTION_CLAIM_METADATA_KEY)} ${release.claimId === null ? 'IS NULL' : '= $3'}`,
        [
          id,
          JSON.stringify(sourceReleaseMetadata(release, new Date().toISOString())),
          ...(release.claimId === null ? [] : [release.claimId]),
        ]
      );
      if ((result.rowCount ?? 0) === 0) return { released: false };
      await beforePublish?.();
      await insertWorkflowEvent(query, sourceReleasedEvent(id, release));
      return { released: true };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_source_release_failed');
    throw new Error(`Failed to release workflow run for unreadable source: ${err.message}`);
  }
}
