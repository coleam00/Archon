import { captureApprovalResolved } from '@archon/paths';
import type { ApprovalContext, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { GateResolutionEvent } from '@archon/workflows/store';
import type { RunActor } from '../run-authorization';
import type { OperationContext } from './context';
import {
  answerText,
  assertAnswerAdmissible,
  lostGateError,
  type GateAnswerOrigin,
} from './answer-admission';
import { answerRun, assertAnswerable, attentionAnswerFor, attentionSugarRequest } from './answer';
import {
  approveWorkflow,
  assertApprovableContext,
  assertDeclaredDecision,
  type ApprovalOperationResult,
} from './approve';
import { assertRejectable, rejectWorkflow, type RejectionOperationResult } from './reject';
import {
  answeredGate,
  answerOccurrence,
  gateCompletionEvent,
  publishGateExecution,
} from './gate-publishing';

/** Read-only response precheck for CLI detach and HTTP validation. */
export function assertRespondable(run: WorkflowRun, decision: string): ApprovalContext | undefined {
  if (decision === 'reject') return assertRejectable(run);
  const approval = assertApprovableContext(run);
  assertDeclaredDecision(run, approval, decision);
  if (decision === 'approve') return approval;
  if (approval.type !== 'approval' && approval.type !== undefined) {
    throw new Error(
      `Run ${run.id}'s gate ('${approval.type}') only accepts 'approve' or 'reject' — ` +
        `'${decision}' is not a valid response here.`
    );
  }
  if (approval.decisionsAuthored !== true) {
    throw new Error(
      `Run ${run.id}'s gate only accepts 'approve' or 'reject' — '${decision}' is not one of its ` +
        'declared decisions. Declare `approval.decisions:` on the gate node to author a broader vocabulary.'
    );
  }
  return approval;
}

/**
 * Read-only precheck for `approve`, `reject` and `respond <decision>` on every surface. At
 * an attention wait the verb is sugar for an answer in the wait's form; at a gate it must
 * be a decision the gate accepts. The operations enforce the same rules.
 */
export function assertResponseAccepted(run: WorkflowRun, decision: string, text?: string): void {
  const sugar = attentionSugarRequest(run, decision, text);
  if (sugar !== undefined) attentionAnswerFor(run, assertAnswerable(run), sugar);
  else assertRespondable(run, decision);
}

/**
 * Resolve a paused gate with an author-declared decision beyond approve/reject
 * (#2707 step 2 — the general `workflow respond <id> <decision> [text]` verb).
 * `approve`/`reject` are NOT handled here — `respondToWorkflow` delegates those
 * to the existing `approveWorkflow`/`rejectWorkflow` functions unchanged, so
 * every gate shape that existed before this PR keeps its exact prior behavior
 * (legacy `on_reject` rework/cancel, `capture_response`, interactive_loop,
 * writeback). This function only ever resolves a new-mode plain gate node
 * (`decisionsAuthored: true`) immediately with structured `{decision, text}`
 * output — the same shape `approveWorkflow`'s new-mode branch writes, just
 * with a caller-supplied `decision` instead of the literal `'approve'`.
 */
async function respondToWorkflowWithDeclaredDecision(
  ctx: OperationContext,
  runId: string,
  decision: string,
  actor: RunActor,
  rawText: string | undefined,
  origin: GateAnswerOrigin
): Promise<ApprovalOperationResult> {
  const text = answerText(rawText);
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_respond_lookup_failed');
  const sugar = attentionSugarRequest(run, decision, text);
  if (sugar !== undefined) return answerRun(ctx, run, sugar, actor, origin, 'respond');
  await ctx.assertMayAct(run, actor, 'respond');
  assertAnswerAdmissible(run, origin);
  const approval = assertRespondable(run, decision);
  if (!approval) throw new Error('Workflow run is paused but missing approval context.');

  const structuredOutput = { decision, text: text ?? '' };
  const events: GateResolutionEvent[] = [
    gateCompletionEvent(
      runId,
      approval,
      decision,
      JSON.stringify(structuredOutput),
      structuredOutput
    ),
    {
      event_type: 'approval_received',
      step_name: approval.nodeId,
      data: {
        via: origin.via,
        ...answerOccurrence(approval),
        decision,
        comment: text ?? decision,
      },
    },
  ];
  const { resolved: won } = await ctx.store.resolveApprovalGate(
    runId,
    { approval: answeredGate(approval, 'approved', origin), approval_response: decision },
    events,
    origin.expectedGate
  );
  if (!won) {
    throw await lostGateError(ctx, runId, origin.expectedGate);
  }

  await publishGateExecution(run, events);

  // Anonymous telemetry: binary resolution only — no ids/comments/names. A
  // custom decision still records as 'approved' since it resolved the gate
  // (as opposed to leaving it open) — mirrors the existing 'approved'/'rejected'
  // vocabulary rather than adding a third telemetry bucket for one caller.
  captureApprovalResolved({ resolution: 'approved' });
  return {
    workflowName: run.workflow_name,
    workingPath: run.working_path,
    userMessage: run.user_message,
    codebaseId: run.codebase_id,
    conversationId: run.conversation_id,
    type: 'approval_gate',
  };
}

/**
 * Resolve a paused gate with any author-declared decision (#2707 step 2's
 * general drive verb — `workflow respond <run-id> <decision> [text]`).
 * `approve`/`reject` are sugar: they delegate to the existing
 * `approveWorkflow`/`rejectWorkflow` functions UNCHANGED, so every gate shape
 * that existed before this PR (legacy `on_reject`, `capture_response`,
 * `interactive_loop`, `writeback`, and step-1's new-mode 2-decision gates)
 * keeps its exact prior behavior byte-for-byte. Any other decision resolves
 * through `respondToWorkflowWithDeclaredDecision`, which only accepts a
 * decision the gate actually declared. Button actions also supply the expected
 * gate occurrence, checked atomically when the store commits the resolution.
 */
export async function respondToWorkflow(
  ctx: OperationContext,
  runId: string,
  decision: string,
  text: string | undefined,
  actor: RunActor,
  origin: GateAnswerOrigin
): Promise<ApprovalOperationResult | RejectionOperationResult> {
  if (decision === 'approve') return approveWorkflow(ctx, runId, text, actor, origin);
  if (decision === 'reject') return rejectWorkflow(ctx, runId, text, actor, origin);
  return respondToWorkflowWithDeclaredDecision(ctx, runId, decision, actor, text, origin);
}
