import { captureApprovalResolved } from '@archon/paths';
import { noExecutorCanWrite, releaseRunScratch } from '@archon/workflows/run-scratch';
import {
  isApprovalContext,
  isGateResolved,
  runAttention,
} from '@archon/workflows/schemas/workflow-run';
import type {
  ApprovalContext,
  RunAttention,
  WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import type { GateResolutionEvent } from '@archon/workflows/store';
import type { RunActor } from '../run-authorization';
import type { OperationContext } from './context';
import {
  answerText,
  assertAnswerAdmissible,
  ChildRunRedirectError,
  lostGateError,
  unreadableGateMessage,
  usageLimitNotAGateMessage,
  type GateAnswerOrigin,
} from './answer-admission';
import { answerRun, attentionSugarRequest } from './answer';
import { assertDeclaredDecision } from './approve';
import {
  answeredGate,
  answerOccurrence,
  gateCompletionEvent,
  publishGateExecution,
} from './gate-publishing';
import { reclaimCancelledRunContainer } from './teardown';

export interface RejectionOperationResult {
  workflowName: string;
  workingPath: string | null;
  userMessage: string | null;
  codebaseId: string | null;
  /** Internal DB UUID — resolve via getConversationById() to get platform_conversation_id. */
  conversationId: string | null;
  /**
   * true = run cancelled; false = staying paused/resumable for one of two
   * reasons distinguished by `newMode` below — a legacy `on_reject` rework
   * being staged, or (#2707 step 1) a new-mode gate resolving with structured
   * output. Callers rendering a message MUST branch on `newMode`, not assume
   * `cancelled === false` means "a rework prompt is about to run."
   */
  cancelled: boolean;
  /** true when cancelled specifically because max rejection attempts were reached (legacy on_reject only) */
  maxAttemptsReached: boolean;
  /**
   * true when this was the engine-level container write-back gate (Phase C). The
   * run stays resumable (never cancelled) so the resume DISCARDS the overlay and
   * completes with a note; lets the CLI/chat print "discarding" instead of the
   * on_reject-rework message.
   */
  writeBack: boolean;
  /**
   * true when this rejection resolved a #2707 step-1 new-mode gate (author
   * explicitly declared `approval.decisions:`) with structured
   * `{decision:'reject', text}` output rather than staging a legacy
   * `on_reject` rework. Only meaningful when `cancelled === false` and
   * `writeBack === false` — distinguishes "resolved, run continues per the
   * workflow's own `when:` wiring" from "a rework prompt is about to run."
   */
  newMode: boolean;
}

/**
 * The one deliberate divergence from approve: unreadable gate METADATA is still
 * rejectable for a legacy gate. Malformed authored decisions are not, nor is an
 * unrecognized TYPE or a block pointer with nothing to follow.
 */
export function isRejectableUnreadableGate(
  run: Pick<WorkflowRun, 'metadata'>,
  attention: Extract<RunAttention, { kind: 'unreadable' }>
): boolean {
  if (attention.reason !== 'malformed_gate') return false;
  const rawApproval = run.metadata.approval;
  return !(
    typeof rawApproval === 'object' &&
    rawApproval !== null &&
    'decisionsAuthored' in rawApproval &&
    rawApproval.decisionsAuthored === true
  );
}

/**
 * The preconditions `rejectWorkflow` enforces. Reads the same `runAttention`
 * decision as `assertApprovable` but acts on one variant differently, and that
 * difference is real: reject has no `nodeId` requirement — it falls back to
 * `approval?.nodeId ?? 'unknown'` when writing its audit event, so a run whose gate
 * legacy metadata is unreadable (`malformed_gate`) is still legitimately rejectable. A
 * well-formed context with an unrecognized `type` is NOT one of those cases — it
 * throws, same as approve. Merging the two gates would either break reject or
 * over-permit approve.
 */
export function assertRejectable(run: WorkflowRun): ApprovalContext | undefined {
  if (run.status !== 'paused') {
    throw new Error(
      `Cannot reject run with status '${run.status}'. Only paused runs can be rejected.`
    );
  }
  const rawApproval = run.metadata.approval;
  const approval: ApprovalContext | undefined = isApprovalContext(rawApproval)
    ? rawApproval
    : undefined;
  const attention = runAttention(run);
  switch (attention?.kind) {
    case 'attention':
      throw new Error(
        `Run ${run.id} is paused at an attention wait, not a gate. Answer it in its form.`
      );
    case 'blocked_on_child':
      // Same redirect as assertApprovable: the parent's pause is not a rejectable
      // gate — cancelling the parent here would silently orphan the still-paused
      // child run. Reject the child (its own gate) or abandon the parent (which
      // cascade-cancels the subtree) instead.
      throw new ChildRunRedirectError(run.id, [attention.childRunId], attention.nodeId, 'reject');
    case 'blocked_on_children':
      throw new ChildRunRedirectError(run.id, attention.childRunIds, attention.nodeId, 'reject');
    case 'unreadable':
      if (isRejectableUnreadableGate(run, attention)) break;
      if (attention.reason === 'malformed_gate') {
        throw new Error(
          `Run ${run.id} has malformed authored decisions. Inspect its gate context before responding.`
        );
      }
      throw new Error(unreadableGateMessage(run, attention, approval));
    case undefined:
      if (approval && isGateResolved(approval)) {
        throw new Error(
          `Workflow run ${run.id} was already ${String(approval.resolved)} and is awaiting resume.`
        );
      }
      break;
    case 'usage_limit':
      throw new Error(usageLimitNotAGateMessage(run, attention));
    case 'awaiting_response':
    case 'stalled_tool_calls':
    case 'terminal':
      // The status guard excludes running and terminal runs.
      break;
    default: {
      const unhandled: never = attention;
      throw new Error(`Unhandled attention kind: ${JSON.stringify(unhandled)}`);
    }
  }
  if (approval) assertDeclaredDecision(run, approval, 'reject');
  return approval;
}

/**
 * Reject a paused workflow run.
 *
 * If `onRejectPrompt` is set and under max attempts, the run stays 'paused'
 * with the rejection staged on the approval context (`resolved: 'rejected'`,
 * #2075) — the resume machinery picks it up and runs the on_reject rework.
 * Otherwise, cancels the run.
 */
export async function rejectWorkflow(
  ctx: OperationContext,
  runId: string,
  rawReason: string | undefined,
  actor: RunActor,
  origin: GateAnswerOrigin
): Promise<RejectionOperationResult> {
  const reason = answerText(rawReason);
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_reject_lookup_failed');
  const sugar = attentionSugarRequest(run, 'reject', reason);
  if (sugar !== undefined) {
    // At an attention wait a reject is an answer like any other; it never cancels.
    const answered = await answerRun(ctx, run, sugar, actor, origin, 'reject');
    return {
      ...answered,
      cancelled: false,
      maxAttemptsReached: false,
      writeBack: false,
      newMode: true,
    };
  }
  await ctx.assertMayAct(run, actor, 'reject');
  assertAnswerAdmissible(run, origin);
  const approval = assertRejectable(run);
  if (approval === undefined) return rejectGate(ctx, run, undefined, reason, origin);

  // Exhaustively switched on the suspend reason (#2489) so a future reason value
  // fails loudly here instead of silently taking the generic rework/cancel path.
  // `assertRejectable` (above) already redirects `child_workflow` before this
  // point — its arm here is an unreachable fail-loud backstop, not live code. An
  // undefined approval takes the generic path exactly as `case undefined` does
  // for a defined approval with no `type`.
  switch (approval.type) {
    case 'writeback':
      return rejectWriteBack(ctx, run, approval, origin);
    case 'child_workflow':
    case 'fan_out':
      // Unreachable: assertRejectable already redirects a child_workflow or fan_out
      // gate to the child runs before this point. Fail loud rather than silently
      // falling through to the generic rework/cancel path if that guard is ever
      // bypassed.
      throw new Error(
        `rejectWorkflow: unexpected ${approval.type} gate reached resolution for run ${runId}`
      );
    case 'approval':
    case 'interactive_loop':
    case undefined:
      return rejectGate(ctx, run, approval, reason, origin);
    default: {
      const unreachable: never = approval.type;
      throw new Error(`rejectWorkflow: unhandled gate type '${String(unreachable)}'`);
    }
  }
}

/**
 * Engine-level container write-back gate (Phase C): reject means DISCARD the
 * overlay, but the RUN itself succeeded — keep it resumable (never cancel) so
 * the resumed executor discards + completes with a note. Distinct from a DAG
 * approval reject (which cancels or stages an on_reject rework).
 */
async function rejectWriteBack(
  ctx: OperationContext,
  run: WorkflowRun,
  approval: ApprovalContext,
  origin: GateAnswerOrigin
): Promise<RejectionOperationResult> {
  const rejectionEvent: GateResolutionEvent = {
    event_type: 'approval_received',
    step_name: approval.nodeId,
    data: {
      via: origin.via,
      ...answerOccurrence(approval),
      decision: 'rejected',
      gate: 'writeback',
    },
  };
  const { resolved: won } = await ctx.store.resolveApprovalGate(
    run.id,
    { approval: answeredGate(approval, 'rejected', origin), approval_response: 'rejected' },
    [rejectionEvent],
    origin.expectedGate
  );
  if (!won) {
    throw await lostGateError(ctx, run.id, origin.expectedGate);
  }
  await publishGateExecution(run, [rejectionEvent]);
  captureApprovalResolved({ resolution: 'rejected' });
  return {
    workflowName: run.workflow_name,
    workingPath: run.working_path,
    userMessage: run.user_message,
    codebaseId: run.codebase_id,
    conversationId: run.conversation_id,
    cancelled: false,
    maxAttemptsReached: false,
    writeBack: true,
    newMode: false,
  };
}

/** What a reject at a DAG gate does: stage an on_reject rework, resolve new-mode, or cancel. */
interface RejectionPlan {
  rejectReason: string;
  currentCount: number;
  maxAttemptsReached: boolean;
  willStageRework: boolean;
  willResolveNewMode: boolean;
}

function rejectionPlan(
  run: WorkflowRun,
  approval: ApprovalContext | undefined,
  reason: string | undefined
): RejectionPlan {
  const currentCount = (run.metadata.rejection_count as number | undefined) ?? 0;
  const maxAttempts = approval?.onRejectMaxAttempts ?? 3;
  // `!= null` (not `!== undefined`): "no on_reject" reaches this read in two stored
  // shapes. Absent — every pause since #2673 (the approval object is replaced
  // wholesale, so an unset field is simply not there), and every SQLite pause before
  // it too, since json_patch is RFC 7396 and DELETED the key the old explicit-null
  // reset patched. An explicit JSON null — Postgres runs paused before #2673, where
  // `||` stored the null as written. Keep the loose check: `null !== undefined` is
  // true, so tightening would read such a run as HAVING an on_reject and stage a
  // rework the workflow never declared — and the resume path takes its prompt from
  // `node.approval.on_reject` (dag-executor), which is exactly what is missing.
  const onRejectConfigured = approval?.onRejectPrompt != null;
  const maxAttemptsReached = onRejectConfigured && currentCount + 1 >= maxAttempts;
  // New mechanism (#2707 step 1): resolves immediately with structured
  // {decision,text} output — no staging, no attempt counter, the run just
  // stays 'paused' awaiting resume like any other completed node (see #2714:
  // this is why hydrateResumableRun needs no special-casing for it). Opt-in
  // ONLY (mirrors approveWorkflow's isNewMode — see its comment): requires
  // the author to have explicitly written `approval.decisions:`, not merely
  // "no on_reject", so an already-authored gate's reject keeps cancelling the
  // run exactly as before this PR. Within an explicitly-decisions-authored
  // gate, one declaring no 'reject' id (an approve-only gate) still falls
  // through to the cancel path — that vocabulary gap is deliberate.
  const decisionsAuthored = approval?.decisionsAuthored === true;
  const hasRejectDecision = approval?.decisions?.some(d => d.id === 'reject') ?? false;
  return {
    rejectReason: reason ?? 'Rejected',
    currentCount,
    maxAttemptsReached,
    // The legacy on_reject rework is staged (run stays 'paused') only when a
    // prompt is set AND we're under the attempt cap.
    willStageRework: onRejectConfigured && !maxAttemptsReached,
    willResolveNewMode: !onRejectConfigured && decisionsAuthored && hasRejectDecision,
  };
}

async function rejectGate(
  ctx: OperationContext,
  run: WorkflowRun,
  approval: ApprovalContext | undefined,
  reason: string | undefined,
  origin: GateAnswerOrigin
): Promise<RejectionOperationResult> {
  const plan = rejectionPlan(run, approval, reason);

  // The audit event is identical for every reject outcome; the CAS writes it
  // in the SAME transaction as the resolution (#2146).
  const rejectionEvent: GateResolutionEvent = {
    event_type: 'approval_received',
    step_name: approval?.nodeId ?? 'unknown',
    data: {
      via: origin.via,
      ...answerOccurrence(approval),
      decision: 'rejected',
      reason: plan.rejectReason,
    },
  };
  const completedGateEvent = await commitRejection(
    ctx,
    run.id,
    approval,
    plan,
    rejectionEvent,
    origin
  );

  await publishGateExecution(
    run,
    completedGateEvent === undefined ? [rejectionEvent] : [completedGateEvent, rejectionEvent]
  );

  const cancelled = !plan.willStageRework && !plan.willResolveNewMode;
  // The container backend removes a container run's scratch only with its container, so
  // the container is reclaimed only once no executor can still run in it. A reclaim
  // failure is logged there.
  if (cancelled && noExecutorCanWrite(run)) {
    await reclaimCancelledRunContainer(ctx, run);
    await releaseRunScratch(run);
  }

  // Won the CAS — resolution/status + audit event already committed atomically.
  // Anonymous telemetry: binary resolution only — no ids/reasons/names.
  captureApprovalResolved({ resolution: 'rejected' });

  return {
    workflowName: run.workflow_name,
    workingPath: run.working_path,
    userMessage: run.user_message,
    codebaseId: run.codebase_id,
    conversationId: run.conversation_id,
    cancelled,
    maxAttemptsReached: plan.maxAttemptsReached,
    writeBack: false,
    newMode: plan.willResolveNewMode,
  };
}

/**
 * Compare-and-swap resolution guard — a concurrent second reject loses here
 * (resolved=false) and throws BEFORE any events, so the gate events can't
 * duplicate (#2113). Stage-rework and new-mode resolution both keep the run
 * 'paused' (the approval context is rewritten whole so a resumed executor
 * still sees nodeId/onRejectPrompt/decisions; `...approval` tolerates a
 * malformed context exactly as the 'unknown' nodeId fallback). The
 * terminal cancel outcome flips paused→'cancelled' in a SINGLE atomic
 * UPDATE, so there is never a resolved-but-not-cancelled state that a failed
 * second write could strand (which a reject retry could not self-heal past
 * the guard above). Every path's audit event(s) ride the same transaction,
 * so a failed event write rolls the resolution/cancellation back rather than
 * losing the audit trail (#2146).
 *
 * Returns the gate's completion event when the reject resolved it new-mode.
 */
async function commitRejection(
  ctx: OperationContext,
  runId: string,
  approval: ApprovalContext | undefined,
  plan: RejectionPlan,
  rejectionEvent: GateResolutionEvent,
  origin: GateAnswerOrigin
): Promise<GateResolutionEvent | undefined> {
  let won: boolean;
  let completedGateEvent: GateResolutionEvent | undefined;
  if (plan.willResolveNewMode && approval) {
    const structuredOutput = { decision: 'reject', text: plan.rejectReason };
    completedGateEvent = gateCompletionEvent(
      runId,
      approval,
      'rejected',
      JSON.stringify(structuredOutput),
      structuredOutput
    );
    ({ resolved: won } = await ctx.store.resolveApprovalGate(
      runId,
      { approval: answeredGate(approval, 'rejected', origin) },
      [completedGateEvent, rejectionEvent],
      origin.expectedGate
    ));
  } else if (plan.willStageRework) {
    ({ resolved: won } = await ctx.store.resolveApprovalGate(
      runId,
      {
        approval: answeredGate(approval, 'rejected', origin),
        rejection_reason: plan.rejectReason,
        rejection_count: plan.currentCount + 1,
      },
      [rejectionEvent],
      origin.expectedGate
    ));
  } else {
    // The CAS writes `workflow_cancelled` itself; this only names the gate that
    // ended the run. A stable token, not the user's rejection prose — that is
    // already on the approval_received event and does not belong on two
    // rows (#2906).
    ({ resolved: won } = await ctx.store.resolveAndCancelApprovalGate(
      runId,
      [rejectionEvent],
      { step_name: approval?.nodeId ?? 'unknown', reason: 'approval_rejected' },
      origin.expectedGate
    ));
  }
  if (!won) {
    throw await lostGateError(ctx, runId, origin.expectedGate);
  }
  return completedGateEvent;
}
