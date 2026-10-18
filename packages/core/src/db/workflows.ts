import {
  TOOL_CALL_ATTENTION_METADATA_KEY,
  toolCallAttentionArraySchema,
  type ToolCallAttention,
} from '@archon/workflows/schemas/workflow-run';
import { getWorkflowEventEmitter } from '@archon/workflows/event-emitter';
import { RUN_AI_CONFIGURATION_METADATA_KEY } from '@archon/workflows/schemas/run-ai-configuration';
/**
 * Database operations for workflow runs
 */
import { lockConversationOwnership } from './conversation-ownership';
import {
  waitContinuedEvent,
  sourceReleaseMetadata,
  EXECUTION_CLAIM_METADATA_KEY,
  sourceReleasedEvent,
  type SourceReleaseWrite,
  type GateResolutionEvent,
} from '@archon/workflows/store';
export {
  WorkflowNotResumableError,
  WorkflowResourceBusyError,
  type GateResolutionEvent,
} from '@archon/workflows/store';
import type { RunExitReason, RunStopSignal } from '@archon/workflows/schemas/run-terminal-reason';
import type { CheckoutObservation } from '@archon/workflows/schemas/checkout-observation';

import { pool, getDialect, getDatabaseType, getDatabase } from './connection';
import type { TransactionQuery } from './resource-slots';
import { insertWorkflowEvent } from './workflow-events';
import { insertTerminalWorkflowEvent } from './workflow-terminal-event';
import { reportRunTerminal } from './workflow-terminal-telemetry';
import {
  normalizeWorkflowRun,
  parseJsonObject,
  type WorkflowRunRow,
} from './workflow-run-normalization';
import { workflowRunOriginSchema } from '@archon/workflows/schemas/workflow-run';
import { assertPublicConversation, ensureWorkflowOriginAnchor } from './workflow-origin-anchor';
import { getLog, jsonIntExtract, lockedRunRow, normalizeMetadata } from './workflow-run-shared';
import { getWorkflowRun, getWorkflowRunStatus } from './workflow-run-reads';
export {
  getWorkflowRun,
  getRunByIsolationEnvId,
  findWorkflowRunsByIdPrefix,
  getWorkflowRunStatus,
  getActiveWorkflowRun,
  getPausedWorkflowRun,
  STALE_PENDING_AGE_MS,
  getActiveWorkflowRunByPath,
  findChildRuns,
  getRunAncestry,
  isRunTranscriptConversation,
  getWorkflowRunByWorkerPlatformId,
  listConversationDetachBlockers,
} from './workflow-run-reads';
export {
  getRunningWorkflows,
  listDashboardRuns,
  listRunsNeedingAttention,
  listAttentionQueueRows,
  listWorkflowRuns,
  findOpenWorkRuns,
  findAdoptingRuns,
  listNotifiedTerminalRuns,
} from './workflow-run-lists';
export {
  findResumableRun,
  findResumableRunByParentConversation,
  resumeWorkflowRun,
  recoverCancelledFanOutRun,
  releasePausedRunSlot,
} from './workflow-run-resume';
import type { IDatabase } from './adapters/types';
import type {
  WorkflowRun,
  WorkflowRunOutcome,
  WorkflowRunStatus,
  ApprovalContext,
  ExpectedApprovalGate,
  WorkflowAttentionWaitContext,
  WorkflowWaitContext,
} from '@archon/workflows/schemas/workflow-run';
import {
  workflowWaitStepName,
  workflowWaitContextSchema,
  TERMINAL_WORKFLOW_STATUSES,
  RUN_STOP_REASON_METADATA_KEY,
  SOURCE_RELEASE_METADATA_KEY,
  readSourceRelease,
  pendingWorkflowWaitDeadline,
  answeredPauseContinuation,
} from '@archon/workflows/schemas/workflow-run';
import type {
  FanOutCancelReason,
  WorkflowCancellationEventDetails,
  WorkflowResumeCursor,
  WorkflowWaitCompletion,
  WorkflowWaitPause,
  NodeStateEventInput,
  GatePauseEventInput,
  AttentionAnswerWrite,
  AttentionLabelWrite,
} from '@archon/workflows/store';
import {
  attentionLabeledEvent,
  labeledAttentionWait,
  answeredAttentionWait,
  waitCompletionEvents,
  waitAnsweredEvent,
  WorkflowRunPauseConflictError,
} from '@archon/workflows/store';

export type WorkflowRunInsert = Parameters<
  import('@archon/workflows/store').IWorkflowStore['createWorkflowRun']
>[0];

/** Guard error for deleteWorkflowRun — re-thrown without wrapping in the outer catch. */
class WorkflowRunGuardError extends Error {}

/**
 * SQL predicate matching a run whose approval gate is still OPEN: the row is
 * 'paused' AND metadata.approval.resolved is JSON null or absent, which `jsonText`
 * reads as SQL NULL, so `IS NULL` matches exactly "not yet resolved". This is the
 * compare-and-swap guard resolveApprovalGate uses to serialize concurrent
 * approve/reject.
 */
function unresolvedGateClause(expectedNodeParamIndex?: number): string {
  const dialect = getDialect();
  const resolvedExpr = dialect.jsonText('metadata', 'approval.resolved');
  const nodeExpr = dialect.jsonText('metadata', 'approval.nodeId');
  const pauseExpr = dialect.jsonText('metadata', 'approval.pauseId');
  const expectedNodeClause =
    expectedNodeParamIndex === undefined
      ? ''
      : ` AND ${nodeExpr} = $${String(expectedNodeParamIndex)} AND ${pauseExpr} IS NOT DISTINCT FROM $${String(expectedNodeParamIndex + 1)}`;
  return `status = 'paused' AND ${resolvedExpr} IS NULL${expectedNodeClause}`;
}

function expectedGateParams(expected: ExpectedApprovalGate | undefined): (string | null)[] {
  if (expected === undefined) return [];
  return typeof expected === 'string' ? [expected, null] : [expected.nodeId, expected.pauseId];
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
  const withoutWait = getDialect().jsonRemove('metadata', 'wait');
  return getDatabaseType() === 'postgresql'
    ? `jsonb_set((${withoutWait}) || ${merge}::jsonb, '{approval}', ${approval}::jsonb, true)`
    : `json_set(json_patch(${withoutWait}, ${merge}), '$.approval', json(${approval}))`;
}

/** Replace the engine-owned wait object and remove any stale human approval. */
function replaceWaitMetadata(paramIndex: number): string {
  const value = `$${String(paramIndex)}`;
  const metadata = getDialect().jsonRemove('metadata', 'approval');
  return getDatabaseType() === 'postgresql'
    ? `jsonb_set(${metadata}, '{wait}', ${value}::jsonb, true)`
    : `json_set(${metadata}, '$.wait', json(${value}))`;
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
 * `false` = the gate is no longer open or its occurrence differs from `expectedGate`.
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
  events: GateResolutionEvent[],
  expectedGate?: ExpectedApprovalGate
): Promise<{ resolved: boolean }> {
  const dialect = getDialect();
  try {
    return await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET metadata = ${dialect.jsonMerge('metadata', 2)}
         WHERE id = $1 AND ${unresolvedGateClause(expectedGate === undefined ? undefined : 3)}`,
        [id, JSON.stringify(metadata), ...expectedGateParams(expectedGate)]
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
 * resolver already won or the occurrence differs from `expectedGate`, so nothing is written.
 */
export async function resolveAndCancelApprovalGate(
  id: string,
  events: GateResolutionEvent[],
  cancellation: WorkflowCancellationEventDetails,
  expectedGate?: ExpectedApprovalGate
): Promise<{ resolved: boolean }> {
  const dialect = getDialect();
  let outcome: { resolved: boolean };
  try {
    outcome = await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'cancelled',
             completed_at = ${dialect.now()}
         WHERE id = $1 AND ${unresolvedGateClause(expectedGate === undefined ? undefined : 2)}`,
        [id, ...expectedGateParams(expectedGate)]
      );
      const resolved = (result.rowCount ?? 0) > 0;
      if (resolved) {
        for (const event of events) {
          await insertWorkflowEvent(query, { workflow_run_id: id, ...event });
        }
        await insertTerminalWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'workflow_cancelled',
          step_name: cancellation.step_name,
          data: {
            cancel_reason: 'approval_rejected',
            ...(cancellation.reason === undefined ? {} : { reason: cancellation.reason }),
          },
        });
      }
      return { resolved };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_resolve_cancel_gate_failed');
    throw new Error(`Failed to resolve and cancel approval gate: ${err.message}`);
  }
  if (outcome.resolved) await reportRunTerminal(id);
  return outcome;
}

export async function insertWorkflowRun(
  query: TransactionQuery,
  data: WorkflowRunInsert
): Promise<WorkflowRun> {
  // Serialize metadata with validation to catch circular references early
  let metadataJson: string;
  try {
    metadataJson = JSON.stringify(data.metadata ?? {});
  } catch (serializeError) {
    const err = serializeError as Error;

    // Losing launch policy would silently change execution on the next resume.
    if (
      data.metadata &&
      ('github_context' in data.metadata || RUN_AI_CONFIGURATION_METADATA_KEY in data.metadata)
    ) {
      getLog().error(
        { err, metadataKeys: Object.keys(data.metadata) },
        'db.workflow_run_metadata_serialize_failed'
      );
      throw new Error(
        `Failed to serialize workflow metadata: ${err.message}. ` +
          'Metadata contains required workflow context or AI configuration.'
      );
    }

    // Non-critical metadata: fall back to empty object and log warning
    getLog().warn(
      { err, metadataKeys: data.metadata ? Object.keys(data.metadata) : [] },
      'db.workflow_run_metadata_serialize_fallback'
    );
    metadataJson = '{}';
  }

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
    return normalizeWorkflowRun(row);
  } catch (error) {
    throw new Error(`Failed to create workflow run: ${(error as Error).message}`);
  }
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
 * A run whose checkout belongs only to destroyed worktree records cannot start.
 * Abandonment marks the record destroyed before its final claimant check, so a run
 * that reused the record too late to be seen fails here instead of starting in a
 * checkout that is being removed.
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
        await insertTerminalWorkflowEvent(query, {
          workflow_run_id: run.id,
          event_type: 'workflow_cancelled',
          data: { cancel_reason: 'conversation_reset' },
        });
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
        await insertTerminalWorkflowEvent(query, {
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
  options: { exitReason?: RunExitReason; signal?: RunStopSignal } = {}
): Promise<{ failed: boolean }> {
  const { exitReason, signal } = options;
  const dialect = getDialect();
  // Both keys belong to ONE failure: the stop reason is written wholesale below, and a
  // quota schedule an older binary wrote with a previous failure is spent once the run
  // ran again. A previous failure's copy is removed before the merge rather than merged
  // into. Postgres `||` replaces a nested object while SQLite's json_patch recurses into
  // it, and a run can reach 'running' again carrying a stale stop reason (resume, or a
  // fan-out cancel recovery) — under json_patch alone that would leave a previous signal
  // attached to a new reason, the #2673 defect through the same mechanism.
  const metadataWithoutPriorFailure = dialect.jsonRemove(
    'metadata',
    'scheduled_resume',
    RUN_STOP_REASON_METADATA_KEY
  );
  let result: Awaited<ReturnType<IDatabase['query']>>;
  try {
    result = await getDatabase().withTransaction(async query => {
      const update = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'failed', completed_at = ${dialect.now()}, metadata = ${dialect.jsonMerge(metadataWithoutPriorFailure, 2)}
         WHERE id = $1 AND status IN ('running', 'pending')`,
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
        ]
      );
      if ((update.rowCount ?? 0) > 0) {
        await insertTerminalWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'workflow_failed',
          data: { error, ...(exitReason !== undefined ? { exit_reason: exitReason } : {}) },
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
        await insertTerminalWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'workflow_cancelled',
          step_name: event?.step_name,
          data: {
            ...(event?.reason === undefined ? {} : { reason: event.reason }),
            ...(event?.cancel_reason === undefined ? {} : { cancel_reason: event.cancel_reason }),
          },
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
        await insertTerminalWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'workflow_cancelled',
          data: { reason, cancel_reason: 'fan_out' },
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
  } else {
    await reportRunTerminal(id);
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
  extraMetadata?: Record<string, unknown>,
  event?: GatePauseEventInput
): Promise<void> {
  try {
    await getDatabase().withTransaction(async query => {
      const result = await query(
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
        throw new WorkflowRunPauseConflictError(id);
      }
      if (event) await insertWorkflowEvent(query, event);
    });
  } catch (error) {
    if (error instanceof WorkflowRunPauseConflictError) throw error;
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
      } else {
        await insertWorkflowEvent(query, waitContinuedEvent(id, parsedWaitContext));
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Workflow run not found')) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_wait_pause_failed');
    throw new Error(`Failed to pause workflow run for wait: ${err.message}`);
  }
}

/** Release a running run whose source this host could not read (see `IWorkflowStore`). */
export async function releaseRunForUnreadableSource(
  id: string,
  release: SourceReleaseWrite
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
      await insertWorkflowEvent(query, sourceReleasedEvent(id, release));
      return { released: true };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_source_release_failed');
    throw new Error(`Failed to release workflow run for unreadable source: ${err.message}`);
  }
}

/** Atomically consume one exact wait cursor and persist its completed node snapshot. */
export async function clearWorkflowWaitContext(
  id: string,
  waitContext: WorkflowWaitContext,
  completion: WorkflowWaitCompletion
): Promise<{ cleared: false } | { cleared: true; nodeEvent: NodeStateEventInput }> {
  const dialect = getDialect();
  const nodeExpr = dialect.jsonText('metadata', 'wait.nodeId');
  const cursorExpr = dialect.jsonText(
    'metadata',
    `wait.${waitContext.kind === 'attention' ? 'waitingSince' : 'resumeAt'}`
  );
  const cursor = waitContext.kind === 'attention' ? waitContext.waitingSince : waitContext.resumeAt;
  const pauseIdExpr = dialect.jsonText('metadata', 'wait.pauseId');
  const occurrenceMatches =
    waitContext.pauseId === undefined ? `${pauseIdExpr} IS NULL` : `${pauseIdExpr} = $4`;
  const clearWait = dialect.jsonRemove('metadata', 'wait');
  try {
    return await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET metadata = ${clearWait}
         WHERE id = $1 AND status = 'running' AND ${nodeExpr} = $2 AND ${cursorExpr} = $3 AND ${occurrenceMatches}`,
        [
          id,
          waitContext.nodeId,
          cursor,
          ...(waitContext.pauseId === undefined ? [] : [waitContext.pauseId]),
        ]
      );
      if ((result.rowCount ?? 0) === 0) return { cleared: false };
      const rows = waitCompletionEvents(id, completion);
      await insertWorkflowEvent(query, rows.outcome);
      await insertWorkflowEvent(query, rows.node);
      return { cleared: true, nodeEvent: rows.node };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_wait_clear_failed');
    throw new Error(`Failed to clear workflow wait: ${err.message}`);
  }
}

/**
 * Return a bounded set of runs eligible for a resume claim: due time, event and usage-limit
 * waits, due quota resumes an older binary scheduled, answered gates and attention waits,
 * and runs released for an unreadable source. The answered clauses mirror
 * `continuablePause`, which the host re-checks when it builds the claim's cursor.
 */
export async function listDueWorkflowContinuations(
  now: Date,
  limit: number
): Promise<WorkflowRun[]> {
  const dialect = getDialect();
  const metadataText = (path: string): string => dialect.jsonText('metadata', path);
  const resumeAt = metadataText('wait.resumeAt');
  const signaledAt = metadataText('wait.signaledAt');
  const waitKind = metadataText('wait.kind');
  const scheduledResumeAt = metadataText('scheduled_resume.resumeAt');
  const scheduledTriggeredAt = metadataText('scheduled_resume.triggeredAt');
  const retryAt = metadataText('continuation_retry_at');
  const answeredGate = `status = 'paused' AND ${metadataText('wait')} IS NULL
               AND COALESCE(${metadataText('isolation')}, '') <> 'container'
               AND ${metadataText('approval.resolved')} IN ('approved', 'rejected')
               AND ${metadataText('approval.pauseId')} IS NOT NULL
               AND COALESCE(${metadataText('approval.nodeId')}, '') <> ''
               AND COALESCE(${metadataText('approval.type')}, 'approval') NOT IN ('child_workflow', 'fan_out', 'writeback')`;
  const answeredAttention = `status = 'paused' AND ${waitKind} = 'attention'
               AND COALESCE(${metadataText('isolation')}, '') <> 'container'
               AND ${metadataText('wait.pauseId')} IS NOT NULL
               AND ${metadataText('wait.answer')} IS NOT NULL`;
  // Each row sorts by its own kind's time. A run resumed from a quota schedule keeps the
  // triggered schedule, which must not place a later answered pause among timed rows.
  const dueAt = `COALESCE(${retryAt}, CASE WHEN status = 'paused' THEN ${resumeAt} END,
               CASE WHEN status = 'failed' THEN ${scheduledResumeAt} END)`;
  try {
    const due: WorkflowRun[] = [];
    let offset = 0;
    // SQL narrows the candidates; typed readers own the persisted cursor contract.
    // Read past malformed candidates so they cannot consume the bounded due slots.
    while (true) {
      const result = await pool.query<WorkflowRunRow>(
        `SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs
       WHERE (${retryAt} IS NULL OR ${retryAt} <= $1)
         AND ((status = 'paused' AND ${metadataText(`${SOURCE_RELEASE_METADATA_KEY}.nodeId`)} IS NULL
               AND ${waitKind} IN ('time', 'event', 'quota')
               AND (${signaledAt} IS NOT NULL OR ${resumeAt} <= $1))
          OR (status = 'failed' AND ${scheduledResumeAt} <= $1 AND ${scheduledTriggeredAt} IS NULL)
          OR (${answeredGate})
          OR (${answeredAttention})
          OR (status = 'paused' AND ${metadataText(`${SOURCE_RELEASE_METADATA_KEY}.nodeId`)} IS NOT NULL
              AND COALESCE(${metadataText('isolation')}, '') <> 'container'))
       ORDER BY CASE WHEN ${dueAt} IS NULL THEN 1 ELSE 0 END, ${dueAt} ASC, id ASC
       LIMIT $2 OFFSET $3`,
        [now.toISOString(), limit, offset]
      );
      for (const row of result.rows) {
        const run = normalizeWorkflowRun(row);
        if (
          run.status !== 'paused' ||
          readSourceRelease(run.metadata) ||
          pendingWorkflowWaitDeadline(run) ||
          answeredPauseContinuation(run)
        )
          due.push(run);
      }
      if (result.rows.length < limit || due.length >= limit) return due.slice(0, limit);
      offset += result.rows.length;
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_continuation_due_list_failed');
    throw new Error(`Failed to list due workflow continuations: ${err.message}`);
  }
}

export interface WorkflowEventSignalCandidate {
  runId: string;
  wait: Extract<WorkflowWaitContext, { kind: 'event' }>;
  outputType: string;
  structuredOutput: unknown;
}

export async function listWorkflowEventSignalCandidates(
  event: string,
  now: Date
): Promise<WorkflowEventSignalCandidate[]> {
  const postgres = getDatabaseType() === 'postgresql';
  const dialect = getDialect();
  // SQLite stores JSON as TEXT, so a malformed row must read as NULL instead of failing the scan.
  const validJson = (column: string, expr: string): string =>
    postgres ? expr : `CASE WHEN json_valid(${column}) THEN ${expr} END`;
  const runJson = (path: string): string =>
    validJson('r.metadata', dialect.jsonText('r.metadata', `wait.${path}`));
  const eventJson = (path: string): string => validJson('e.data', dialect.jsonText('e.data', path));
  const structuredOutputType = postgres
    ? "CASE WHEN e.data ? 'structured_output' THEN jsonb_typeof(e.data->'structured_output') END"
    : "CASE WHEN json_valid(e.data) THEN json_type(e.data, '$.structured_output') END";

  interface CandidateRow {
    run_id: string;
    run_metadata: unknown;
    event_data: unknown;
  }

  try {
    const result = await pool.query<CandidateRow>(
      `SELECT r.id AS run_id, r.metadata AS run_metadata, e.data AS event_data
       FROM remote_agent_workflow_runs r
       JOIN remote_agent_workflow_events e ON e.workflow_run_id = r.id
       WHERE r.status = 'paused'
         AND ${runJson('kind')} = 'event'
         AND ${runJson('event')} = $1
         AND ${runJson('signaledAt')} IS NULL
         AND ${runJson('resumeAt')} > $2
         AND e.event_type = 'node_completed'
         AND ${eventJson('output_type')} IS NOT NULL
         AND ${eventJson('output_type')} <> ''
         AND ${structuredOutputType} IS NOT NULL
         AND ${structuredOutputType} <> 'null'`,
      [event, now.toISOString()]
    );

    const candidates: WorkflowEventSignalCandidate[] = [];
    for (const row of result.rows) {
      const metadata = parseJsonObject(row.run_metadata);
      const eventData = parseJsonObject(row.event_data);
      if (!metadata || !eventData) continue;

      const parsedWait = workflowWaitContextSchema.safeParse(metadata.wait);
      const outputType = eventData.output_type;
      if (
        !parsedWait.success ||
        parsedWait.data.kind !== 'event' ||
        parsedWait.data.event !== event ||
        parsedWait.data.signaledAt !== undefined ||
        Date.parse(parsedWait.data.resumeAt) <= now.getTime() ||
        typeof outputType !== 'string' ||
        outputType === '' ||
        !Object.hasOwn(eventData, 'structured_output')
      ) {
        continue;
      }

      candidates.push({
        runId: row.run_id,
        wait: parsedWait.data,
        outputType,
        structuredOutput: eventData.structured_output,
      });
    }
    return candidates;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, event }, 'db.workflow_event_signal_candidates_list_failed');
    throw new Error(`Failed to list workflow event signal candidates: ${err.message}`);
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
  const metadataText = (path: string): string => dialect.jsonText('metadata', path);
  const waitResumeAt = metadataText('wait.resumeAt');
  const scheduledResumeAt = metadataText('scheduled_resume.resumeAt');
  const scheduledTriggeredAt = metadataText('scheduled_resume.triggeredAt');
  const waitNodeId = metadataText('wait.nodeId');
  const scheduledAttempt = jsonIntExtract('metadata', 'scheduled_resume.attempt');
  const gatePauseId = metadataText('approval.pauseId');
  const gateNodeId = metadataText('approval.nodeId');
  const waitPauseId = metadataText('wait.pauseId');
  const releaseNodeId = metadataText(`${SOURCE_RELEASE_METADATA_KEY}.nodeId`);
  const releasedAt = metadataText(`${SOURCE_RELEASE_METADATA_KEY}.releasedAt`);
  const releaseId = metadataText(`${SOURCE_RELEASE_METADATA_KEY}.releaseId`);
  try {
    await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET metadata = ${dialect.jsonMerge('metadata', 2)}
       WHERE id = $1 AND ((status = 'paused' AND ${releaseNodeId} IS NULL AND ${waitResumeAt} = $3 AND ${waitNodeId} = $4
           AND (${waitPauseId} = $7 OR (${waitPauseId} IS NULL AND $7 IS NULL)))
         OR (status = 'failed' AND ${scheduledResumeAt} = $3
           AND ${scheduledTriggeredAt} IS NULL AND ${scheduledAttempt} = $5)
         OR (status = 'paused' AND ${releaseNodeId} IS NULL AND ${gatePauseId} = $6 AND ${gateNodeId} = $4)
         OR (status = 'paused' AND ${releaseNodeId} IS NULL AND ${waitPauseId} = $6 AND ${waitNodeId} = $4)
         OR (status = 'paused' AND ${releaseNodeId} = $4 AND ${releasedAt} = $8
           AND (${releaseId} = $9 OR (${releaseId} IS NULL AND $9 IS NULL))))`,
      [
        id,
        JSON.stringify({ continuation_retry_at: retryAt }),
        cursor.kind === 'wait' || cursor.kind === 'quota' ? cursor.resumeAt : null,
        cursor.kind === 'quota' ? null : cursor.nodeId,
        cursor.kind === 'quota' ? cursor.attempt : null,
        cursor.kind === 'answered' ? cursor.pauseId : null,
        cursor.kind === 'wait' ? (cursor.pauseId ?? null) : null,
        cursor.kind === 'source' ? cursor.releasedAt : null,
        cursor.kind === 'source' ? (cursor.releaseId ?? null) : null,
      ]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_continuation_defer_failed');
    throw new Error(`Failed to defer workflow continuation: ${err.message}`);
  }
}

/** Atomically add one answer to an open attention wait (see `IWorkflowStore.answerAttentionWait`). */
export async function answerAttentionWait(
  id: string,
  write: AttentionAnswerWrite
): Promise<{ answered: boolean }> {
  try {
    return await getDatabase().withTransaction(async query => {
      const row = await lockedRunRow(query, id);
      const answered =
        row &&
        answeredAttentionWait(
          { status: row.status, metadata: normalizeMetadata(row.metadata) },
          write
        );
      if (!answered) return { answered: false };
      await writeWaitContext(query, id, workflowWaitContextSchema.parse(answered));
      await insertWorkflowEvent(query, waitAnsweredEvent(id, answered));
      return { answered: true };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_attention_answer_failed');
    throw new Error(`Failed to answer attention wait: ${err.message}`);
  }
}

/** Atomically apply one label write to an open attention wait (see `IWorkflowStore.labelAttentionWait`). */
export async function labelAttentionWait(
  id: string,
  write: AttentionLabelWrite
): Promise<{ labeled: true; wait: WorkflowAttentionWaitContext } | { labeled: false }> {
  try {
    return await getDatabase().withTransaction(async query => {
      const row = await lockedRunRow(query, id);
      const labeled =
        row &&
        labeledAttentionWait(
          { status: row.status, metadata: normalizeMetadata(row.metadata) },
          write
        );
      if (!labeled) return { labeled: false } as const;
      await writeWaitContext(query, id, labeled);
      await insertWorkflowEvent(query, attentionLabeledEvent(id, labeled, write));
      return { labeled: true, wait: labeled } as const;
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_attention_label_failed');
    throw new Error(`Failed to label attention wait: ${err.message}`);
  }
}

async function writeWaitContext(
  query: TransactionQuery,
  id: string,
  wait: WorkflowWaitContext
): Promise<void> {
  const writeWait =
    getDatabaseType() === 'postgresql'
      ? "jsonb_set(metadata, '{wait}', $2::jsonb, true)"
      : "json_set(metadata, '$.wait', json($2))";
  await query(`UPDATE remote_agent_workflow_runs SET metadata = ${writeWait} WHERE id = $1`, [
    id,
    JSON.stringify(wait),
  ]);
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
  const dialect = getDialect();
  const eventExpr = dialect.jsonText('metadata', 'wait.event');
  const nodeExpr = dialect.jsonText('metadata', 'wait.nodeId');
  const signaledExpr = dialect.jsonText('metadata', 'wait.signaledAt');
  const resumeAtExpr = dialect.jsonText('metadata', 'wait.resumeAt');
  const pauseIdExpr = dialect.jsonText('metadata', 'wait.pauseId');
  const pauseIdParam = payload === undefined ? 6 : 7;
  const occurrenceMatch =
    parsedWaitContext.pauseId === undefined
      ? `${pauseIdExpr} IS NULL`
      : `${pauseIdExpr} = $${String(pauseIdParam)}`;
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
           AND ${occurrenceMatch}
           AND ${signaledExpr} IS NULL AND ${resumeAtExpr} > $5`,
        payload === undefined
          ? [
              id,
              parsedWaitContext.event,
              parsedWaitContext.nodeId,
              parsedWaitContext.resumeAt,
              signaledAt,
              ...(parsedWaitContext.pauseId === undefined ? [] : [parsedWaitContext.pauseId]),
            ]
          : [
              id,
              parsedWaitContext.event,
              parsedWaitContext.nodeId,
              parsedWaitContext.resumeAt,
              signaledAt,
              JSON.stringify(payload),
              ...(parsedWaitContext.pauseId === undefined ? [] : [parsedWaitContext.pauseId]),
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

export type {
  DashboardWorkflowRun,
  ListDashboardRunsOptions,
  DashboardRunsResult,
} from '../schemas/workflow-run';

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
