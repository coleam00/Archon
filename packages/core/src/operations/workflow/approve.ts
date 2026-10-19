import { captureApprovalResolved } from '@archon/paths';
import {
  isApprovalContext,
  isGateResolved,
  runAttention,
} from '@archon/workflows/schemas/workflow-run';
import type {
  ApprovalContext,
  LoopGateRunMetadata,
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
import {
  answeredGate,
  answerOccurrence,
  gateCompletionEvent,
  publishGateExecution,
} from './gate-publishing';

export interface ApprovalOperationResult {
  workflowName: string;
  workingPath: string | null;
  userMessage: string | null;
  codebaseId: string | null;
  /** Internal DB UUID — resolve via getConversationById() to get platform_conversation_id. */
  conversationId: string | null;
  type: 'interactive_loop' | 'approval_gate' | 'attention';
}

/**
 * The preconditions `approveWorkflow` enforces, as ONE reusable gate.
 *
 * Extracted so the CLI's read-only `--detach` precheck validates exactly what the
 * child will enforce. A partial copy is worse than none: the parent acks
 * `{ ok: true }` and the child then dies unseen in its log — precisely the failure
 * `--detach` exists to prevent, on the surface nobody is watching.
 *
 * Pure and synchronous (the caller already holds the run), so both the operation
 * and the CLI precheck can call it without a second DB round-trip.
 *
 * Returns the validated context so callers keep today's narrowing — `nodeId` is a
 * required field on ApprovalContext, so no intersection type is needed.
 */
export function assertApprovable(run: WorkflowRun): ApprovalContext {
  const approval = assertApprovableContext(run);
  assertDeclaredDecision(run, approval, 'approve');
  return approval;
}

export function assertApprovableContext(run: WorkflowRun): ApprovalContext {
  if (run.status !== 'paused') {
    throw new Error(
      `Cannot approve run with status '${run.status}'. Only paused runs can be approved.`
    );
  }
  const rawApproval = run.metadata.approval;
  const approval: ApprovalContext | undefined = isApprovalContext(rawApproval)
    ? rawApproval
    : undefined;
  // `runAttention` owns the decision — is a response needed, and on which run. This
  // function still reads the gate CONTEXT afterwards, because its callers need the
  // decisions, session, and iteration the attention value deliberately omits.
  const attention = runAttention(run);
  switch (attention?.kind) {
    case 'awaiting_response':
      // Reported only for a well-formed, unresolved gate, so the context read above
      // is present; the check keeps that provable to the compiler.
      if (!approval) throw new Error('Workflow run is paused but missing approval context.');
      return approval;
    case 'blocked_on_child':
      // A parent blocked on a `workflow:` sub-run has no approvable gate of its
      // own — the pause resolves automatically when the child run completes.
      // Falling through to the generic branch would stamp a node_completed for the
      // parent's workflow node with empty output (the child's real output is then
      // discarded on resume) and orphan the still-paused child. Redirect the
      // operator to the child run, where the actual gate lives.
      throw new ChildRunRedirectError(run.id, [attention.childRunId], attention.nodeId, 'approve');
    case 'blocked_on_children':
      // A fan-out parent waits on each unfinished child, and each child is answered by
      // its own run id — never through the parent.
      throw new ChildRunRedirectError(run.id, attention.childRunIds, attention.nodeId, 'approve');
    case 'attention':
      throw new Error(
        `Run ${run.id} is paused at an attention wait, not a gate. Answer it in its form.`
      );
    case 'usage_limit':
      throw new Error(usageLimitNotAGateMessage(run, attention));
    case 'unreadable':
      throw new Error(unreadableGateMessage(run, attention, approval));
    case 'stalled_tool_calls':
    case 'terminal':
      // The status guard excludes running and terminal runs.
      throw new Error(
        `Cannot approve run with status '${run.status}'. Only paused runs can be approved.`
      );
    case undefined:
      // Nothing needs a person. Either the gate is already resolved and the run is
      // only awaiting auto-resume, or it is parked on a durable `wait:` with no gate.
      //
      // The resolved read is a fast-path friendly error for the common (sequential)
      // case: the run stays 'paused' after a resolution, so the status check alone no
      // longer blocks a second approve. It can still race a concurrent approve — the
      // resolveApprovalGate CAS is the real arbiter; a second approve that slips past
      // this read loses the atomic UPDATE and throws the same way.
      throw new Error(
        approval && isGateResolved(approval)
          ? `Workflow run ${run.id} was already ${String(approval.resolved)} and is awaiting resume.`
          : 'Workflow run is paused but missing approval context.'
      );
  }
}

export function assertDeclaredDecision(
  run: WorkflowRun,
  approval: ApprovalContext,
  decision: string
): void {
  if (
    (approval.type !== 'approval' && approval.type !== undefined) ||
    approval.decisionsAuthored !== true
  )
    return;
  const declaredIds = approval.decisions.map(d => d.id);
  if (!declaredIds.includes(decision)) {
    throw new Error(
      `Run ${run.id}'s gate does not declare decision '${decision}'. Declared decisions: ` +
        `${declaredIds.join(', ')}.`
    );
  }
}

/**
 * Approve a paused workflow run.
 *
 * Handles both interactive_loop and standard approval gate paths.
 * The run STAYS 'paused' — the resolution is recorded on the approval context
 * (`metadata.approval.resolved`, #2075) and the resume machinery already picks
 * up paused runs (resumableStatusClause / findResumableRunByParentConversation).
 * Does NOT auto-resume — callers decide whether to execute.
 */
export async function approveWorkflow(
  ctx: OperationContext,
  runId: string,
  rawComment: string | undefined,
  actor: RunActor,
  origin: GateAnswerOrigin
): Promise<ApprovalOperationResult> {
  const comment = answerText(rawComment);
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_approve_lookup_failed');
  const sugar = attentionSugarRequest(run, 'approve', comment);
  if (sugar !== undefined) return answerRun(ctx, run, sugar, actor, origin, 'approve');
  await ctx.assertMayAct(run, actor, 'approve');
  assertAnswerAdmissible(run, origin);
  const approval = assertApprovable(run);

  const approvalComment = comment ?? 'Approved';
  const isInteractiveLoop = approval.type === 'interactive_loop';

  // Build the resolution metadata AND the audit events for this gate type.
  // IMPORTANT: metadata is MERGED (not replaced) and the approval context is
  // rewritten whole (spread + resolved) so it survives intact for the resumed
  // executor's startIteration detection. Both are handed to the CAS below, which
  // stamps the metadata and writes the events in ONE transaction — the atomic
  // double-resolution guard (#2113) and the atomic audit trail (#2146).
  //
  // Exhaustively switched on the suspend reason (#2489) so a future reason value
  // fails loudly here instead of silently taking the generic 'approval' shape
  // below. `assertApprovable` (above) already redirects `child_workflow` before
  // this point — its arm here is an unreachable fail-loud backstop, not live code.
  let metadataPayload: Record<string, unknown>;
  let events: GateResolutionEvent[];
  switch (approval.type) {
    case 'writeback': {
      // Engine-level container write-back gate (Phase C): record the approval so the
      // resumed executor applies the overlay diff to the live root. The gate discriminates
      // on the gate's OWN `metadata.approval.resolved` (set here) — NOT the run-wide
      // `approval_response`, which is kept only for backward-compat/telemetry (H1). NO
      // node_completed event — there is no DAG node behind this gate (`nodeId` is synthetic).
      metadataPayload = {
        approval: answeredGate(approval, 'approved', origin),
        approval_response: 'approved',
      };
      events = [
        {
          event_type: 'approval_received',
          step_name: approval.nodeId,
          data: {
            via: origin.via,
            ...answerOccurrence(approval),
            decision: 'approved',
            comment: approvalComment,
            gate: 'writeback',
          },
        },
      ];
      break;
    }
    case 'interactive_loop': {
      // Finalize-vs-iterate discriminator (#2074): derived from the given comment,
      // not approvalComment (which defaults to 'Approved') — a bare approve on a
      // signal-bearing gate finalizes at resume; real feedback runs another iteration.
      const feedbackProvided = comment !== undefined;
      // loop_user_input keeps the 'Approved' default so the iterate path (non-signaled
      // gates) still feeds the AI an approval token via $LOOP_USER_INPUT. Typed via
      // LoopGateRunMetadata so the key spellings match the executor's resume-time
      // read sites (a typo here is a compile error).
      const gateRunMetadata: LoopGateRunMetadata = {
        loop_user_input: approvalComment,
        loop_feedback_given: feedbackProvided,
      };
      metadataPayload = {
        approval: answeredGate(approval, 'approved', origin),
        ...gateRunMetadata,
      };
      // Interactive loop gate — user input already stored in metadata for the next
      // iteration. Note: node_completed is NOT written here. The executor writes it
      // when the AI emits the completion signal (meaning the user actually approved)
      // — or, for a signal-bearing gate approved without feedback, at resume time
      // from the persisted signaledOutput (#2074). Writing it here would cause the
      // resume to skip the loop node entirely.
      events = [
        {
          event_type: 'approval_received',
          step_name: approval.nodeId,
          data: {
            via: origin.via,
            ...answerOccurrence(approval),
            decision: 'approved',
            comment: approvalComment,
            iteration: approval.iteration,
          },
        },
      ];
      break;
    }
    case 'approval':
    case undefined: {
      metadataPayload = {
        approval: answeredGate(approval, 'approved', origin),
        approval_response: 'approved',
        rejection_reason: '',
        rejection_count: 0,
      };
      // New-mode resolution is opt-in: only a gate whose author explicitly
      // wrote `approval.decisions:` (decisionsAuthored) — never merely "no
      // on_reject" — gets structured output. No workflow authored before
      // #2707 step 1 can have written `decisions:`, so every already-authored
      // gate (bare, or `capture_response`-only) keeps its exact pre-PR plain-
      // text/empty output regardless of on_reject. `text` is the given comment
      // (empty when none), not `approvalComment`'s display default.
      const isNewMode = approval.onRejectPrompt == null && approval.decisionsAuthored === true;
      const nodeOutput = isNewMode
        ? JSON.stringify({ decision: 'approve', text: comment ?? '' })
        : approval.captureResponse === true
          ? approvalComment
          : '';
      events = [
        gateCompletionEvent(
          runId,
          approval,
          'approved',
          nodeOutput,
          isNewMode ? { decision: 'approve', text: comment ?? '' } : undefined
        ),
        {
          event_type: 'approval_received',
          step_name: approval.nodeId,
          data: {
            via: origin.via,
            ...answerOccurrence(approval),
            decision: 'approved',
            comment: approvalComment,
          },
        },
      ];
      break;
    }
    case 'child_workflow':
    case 'fan_out':
      // Unreachable: assertApprovable already redirects a child_workflow or fan_out
      // gate to the child runs before this point. Fail loud rather than silently
      // falling through to the generic 'approval' shape above if that guard is ever
      // bypassed.
      throw new Error(
        `approveWorkflow: unexpected ${approval.type} gate reached resolution for run ${runId}`
      );
    default: {
      const unreachable: never = approval.type;
      throw new Error(`approveWorkflow: unhandled gate type '${String(unreachable)}'`);
    }
  }

  // Compare-and-swap: stamp the resolution AND write the audit events ONLY while
  // the gate is still open, all in one transaction. This atomic UPDATE — not the
  // isGateResolved read above — is the real arbiter, so a concurrent second
  // approve loses here (resolved=false) and throws BEFORE any events/telemetry
  // land, eliminating the duplicates (#2113); folding the events into the same
  // transaction means a failed event write rolls the resolution back so a retry
  // can win the still-open gate (#2146). The run stays 'paused'; resume is
  // guarded independently by resumeWorkflowRun's CAS.
  const { resolved: won } = await ctx.store.resolveApprovalGate(
    runId,
    metadataPayload,
    events,
    origin.expectedGate
  );
  if (!won) {
    throw await lostGateError(ctx, runId, origin.expectedGate);
  }

  await publishGateExecution(run, events);

  // Won the CAS — resolution + audit events already committed atomically.
  // Anonymous telemetry: binary resolution only — no ids/comments/names.
  captureApprovalResolved({ resolution: 'approved' });
  return {
    workflowName: run.workflow_name,
    workingPath: run.working_path,
    userMessage: run.user_message,
    codebaseId: run.codebase_id,
    conversationId: run.conversation_id,
    type: isInteractiveLoop ? 'interactive_loop' : 'approval_gate',
  };
}
