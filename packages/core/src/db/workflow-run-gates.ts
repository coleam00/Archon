/**
 * Approval gates on workflow runs: pausing a run for human approval and the
 * compare-and-swap writes that resolve or cancel its gate. Re-exported from the
 * `./workflows` entry.
 */
import {
  validateWorkflowWaitMetadata,
  type ApprovalContext,
  type ExpectedApprovalGate,
} from '@archon/workflows/schemas/workflow-run';
import {
  PAUSE_CAUSE_METADATA_KEY,
  pauseCauseOfApproval,
} from '@archon/workflows/schemas/pause-cause';
import {
  WorkflowRunPauseConflictError,
  type GatePauseEventInput,
  type GateResolutionEvent,
  type WorkflowCancellationEventDetails,
} from '@archon/workflows/store';
import { getDatabase, getDatabaseType, getDialect } from './connection';
import { insertWorkflowEvent } from './workflow-events';
import { getLog } from './workflow-run-shared';
import {
  insertTerminalWorkflowEvent,
  observeRunTerminalArtifacts,
} from './workflow-terminal-event';
import { reportRunTerminal } from './workflow-terminal-telemetry';

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
  const merged =
    getDatabaseType() === 'postgresql'
      ? `(metadata || ${merge}::jsonb)`
      : `json_patch(metadata, ${merge})`;
  const withoutWait = getDialect().jsonRemove(merged, 'wait');
  return getDatabaseType() === 'postgresql'
    ? `jsonb_set(${withoutWait}, '{approval}', ${approval}::jsonb, true)`
    : `json_set(${withoutWait}, '$.approval', json(${approval}))`;
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
  validateWorkflowWaitMetadata(metadata);
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
 * pass it: this is a terminal status write, and every other terminal writer
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
    const artifacts = await observeRunTerminalArtifacts(id);
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
        const { step_name, ...data } = cancellation;
        await insertTerminalWorkflowEvent(
          query,
          {
            workflow_run_id: id,
            event_type: 'workflow_cancelled',
            step_name,
            data: { ...data, cancel_reason: 'approval_rejected' },
          },
          artifacts
        );
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
          JSON.stringify({
            ...extraMetadata,
            [PAUSE_CAUSE_METADATA_KEY]: pauseCauseOfApproval(approvalContext),
          }),
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
