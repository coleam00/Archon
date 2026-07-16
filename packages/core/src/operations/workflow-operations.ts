/**
 * Shared workflow business logic — approve, reject, status, resume, abandon.
 *
 * Both CLI and command-handler are thin formatting adapters over these functions.
 * Operations throw on errors; callers catch and format for their platform.
 */
import { createLogger, captureApprovalResolved } from '@archon/paths';
import {
  RESUMABLE_WORKFLOW_STATUSES,
  isApprovalContext,
  isGateResolved,
} from '@archon/workflows/schemas/workflow-run';
import type {
  WorkflowRun,
  ApprovalContext,
  LoopGateRunMetadata,
} from '@archon/workflows/schemas/workflow-run';
import * as workflowDb from '../db/workflows';
import * as workflowNodeSessionDb from '../db/workflow-node-sessions';

// Lazy logger — NEVER at module scope
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('operations');
  return cachedLog;
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface WorkflowStatusData {
  runs: WorkflowRun[];
}

export interface ApprovalOperationResult {
  workflowName: string;
  workingPath: string | null;
  userMessage: string | null;
  codebaseId: string | null;
  /** Internal DB UUID — resolve via getConversationById() to get platform_conversation_id. */
  conversationId: string;
  type: 'interactive_loop' | 'approval_gate';
}

export interface RejectionOperationResult {
  workflowName: string;
  workingPath: string | null;
  userMessage: string | null;
  codebaseId: string | null;
  /** Internal DB UUID — resolve via getConversationById() to get platform_conversation_id. */
  conversationId: string;
  /** true = run cancelled; false = transitioning to failed for retry (has onRejectPrompt) */
  cancelled: boolean;
  /** true when cancelled specifically because max rejection attempts were reached */
  maxAttemptsReached: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getRunOrThrow(runId: string, logEvent: string): Promise<WorkflowRun> {
  let run: WorkflowRun | null;
  try {
    run = await workflowDb.getWorkflowRun(runId);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, errorType: err.constructor.name, runId }, logEvent);
    throw new Error(`Failed to look up workflow run ${runId}: ${err.message}`);
  }
  if (!run) {
    throw new Error(`Workflow run not found: ${runId}`);
  }
  return run;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * List all running and paused workflow runs.
 */
export async function getWorkflowStatus(): Promise<WorkflowStatusData> {
  const runs = await workflowDb.listWorkflowRuns({
    status: ['running', 'paused'],
    limit: 50,
  });
  return { runs };
}

/**
 * Validate that a run can be resumed and return it.
 * Does NOT execute the workflow — callers decide whether to run.
 */
export async function resumeWorkflow(runId: string): Promise<WorkflowRun> {
  const run = await getRunOrThrow(runId, 'operations.workflow_resume_lookup_failed');
  if (!RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) {
    throw new Error(
      `Cannot resume run with status '${run.status}'. Only failed or paused runs can be resumed.`
    );
  }
  return run;
}

/**
 * Abandon a workflow run (marks it as cancelled).
 *
 * Running, paused, AND failed runs can be abandoned. A `failed` run is terminal
 * per TERMINAL_WORKFLOW_STATUSES but remains resumable, so the user must be able
 * to discard it — hence the inline check here intentionally diverges from that
 * constant and blocks only the two non-resumable terminal states.
 */
export async function abandonWorkflow(runId: string): Promise<WorkflowRun> {
  const run = await getRunOrThrow(runId, 'operations.workflow_abandon_lookup_failed');
  if (run.status === 'completed' || run.status === 'cancelled') {
    throw new Error(
      `Cannot abandon run with status '${run.status}'. Only running, paused, or failed runs can be abandoned.`
    );
  }
  try {
    await workflowDb.cancelWorkflowRun(runId);
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, errorType: err.constructor.name, runId },
      'operations.workflow_abandon_failed'
    );
    throw new Error(`Failed to abandon workflow run ${runId}: ${err.message}`);
  }
  return run;
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
  runId: string,
  comment?: string
): Promise<ApprovalOperationResult> {
  const run = await getRunOrThrow(runId, 'operations.workflow_approve_lookup_failed');
  if (run.status !== 'paused') {
    throw new Error(
      `Cannot approve run with status '${run.status}'. Only paused runs can be approved.`
    );
  }
  const rawApproval = run.metadata.approval;
  const approval: ApprovalContext | undefined = isApprovalContext(rawApproval)
    ? rawApproval
    : undefined;
  if (!approval?.nodeId) {
    throw new Error('Workflow run is paused but missing approval context.');
  }
  if (isGateResolved(approval)) {
    // Fast-path friendly error for the common (sequential) case. The run stays
    // 'paused' after a resolution, so the status check alone no longer blocks a
    // second approve. This in-memory read can still race a concurrent approve —
    // the resolveApprovalGate CAS below is the real arbiter; a second approve
    // that slips past this read loses the atomic UPDATE and throws the same way.
    throw new Error(
      `Workflow run ${runId} was already ${String(approval.resolved)} and is awaiting resume.`
    );
  }

  // Whitespace-only comments count as absent (mirrors feedbackProvided below):
  // HTTP/CLI/chat pass the raw comment through since #2074, so '   ' would
  // otherwise be recorded verbatim where the documented default is 'Approved'.
  const approvalComment = comment !== undefined && comment.trim().length > 0 ? comment : 'Approved';
  const isInteractiveLoop = approval.type === 'interactive_loop';

  // Build the resolution metadata AND the audit events for this gate type.
  // IMPORTANT: metadata is MERGED (not replaced) and the approval context is
  // rewritten whole (spread + resolved) so it survives intact for the resumed
  // executor's startIteration detection. Both are handed to the CAS below, which
  // stamps the metadata and writes the events in ONE transaction — the atomic
  // double-resolution guard (#2113) and the atomic audit trail (#2146).
  let metadataPayload: Record<string, unknown>;
  let events: workflowDb.GateResolutionEvent[];
  if (isInteractiveLoop) {
    // Finalize-vs-iterate discriminator (#2074): derived from the RAW comment,
    // not approvalComment (which defaults to 'Approved') — a bare approve on a
    // signal-bearing gate finalizes at resume; real feedback runs another iteration.
    const feedbackProvided = comment !== undefined && comment.trim().length > 0;
    // loop_user_input keeps the 'Approved' default so the iterate path (non-signaled
    // gates) still feeds the AI an approval token via $LOOP_USER_INPUT. Typed via
    // LoopGateRunMetadata so the key spellings match the executor's resume-time
    // read sites (a typo here is a compile error).
    const gateRunMetadata: LoopGateRunMetadata = {
      loop_user_input: approvalComment,
      loop_feedback_given: feedbackProvided,
    };
    metadataPayload = { approval: { ...approval, resolved: 'approved' }, ...gateRunMetadata };
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
        data: { decision: 'approved', comment: approvalComment, iteration: approval.iteration },
      },
    ];
  } else {
    metadataPayload = {
      approval: { ...approval, resolved: 'approved' },
      approval_response: 'approved',
      rejection_reason: '',
      rejection_count: 0,
    };
    const nodeOutput = approval.captureResponse === true ? approvalComment : '';
    events = [
      {
        event_type: 'node_completed',
        step_name: approval.nodeId,
        data: { node_output: nodeOutput, approval_decision: 'approved' },
      },
      {
        event_type: 'approval_received',
        step_name: approval.nodeId,
        data: { decision: 'approved', comment: approvalComment },
      },
    ];
  }

  // Compare-and-swap: stamp the resolution AND write the audit events ONLY while
  // the gate is still open, all in one transaction. This atomic UPDATE — not the
  // isGateResolved read above — is the real arbiter, so a concurrent second
  // approve loses here (resolved=false) and throws BEFORE any events/telemetry
  // land, eliminating the duplicates (#2113); folding the events into the same
  // transaction means a failed event write rolls the resolution back so a retry
  // can win the still-open gate (#2146). The run stays 'paused'; resume is
  // guarded independently by resumeWorkflowRun's CAS.
  const { resolved: won } = await workflowDb.resolveApprovalGate(runId, metadataPayload, events);
  if (!won) {
    throw new Error(`Workflow run ${runId} was already resolved and is awaiting resume.`);
  }

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

/**
 * Reject a paused workflow run.
 *
 * If `onRejectPrompt` is set and under max attempts, the run stays 'paused'
 * with the rejection staged on the approval context (`resolved: 'rejected'`,
 * #2075) — the resume machinery picks it up and runs the on_reject rework.
 * Otherwise, cancels the run.
 */
export async function rejectWorkflow(
  runId: string,
  reason?: string
): Promise<RejectionOperationResult> {
  const run = await getRunOrThrow(runId, 'operations.workflow_reject_lookup_failed');
  if (run.status !== 'paused') {
    throw new Error(
      `Cannot reject run with status '${run.status}'. Only paused runs can be rejected.`
    );
  }
  const rawApproval = run.metadata.approval;
  const approval: ApprovalContext | undefined = isApprovalContext(rawApproval)
    ? rawApproval
    : undefined;
  if (approval && isGateResolved(approval)) {
    // Fast-path friendly error, same as approveWorkflow — the run stays 'paused'
    // after a resolution, so status alone no longer blocks a second reject. The
    // CAS below is the real arbiter for the concurrent case.
    throw new Error(
      `Workflow run ${runId} was already ${String(approval.resolved)} and is awaiting resume.`
    );
  }
  const rejectReason = reason ?? 'Rejected';
  const currentCount = (run.metadata.rejection_count as number | undefined) ?? 0;
  const maxAttempts = approval?.onRejectMaxAttempts ?? 3;
  const onRejectConfigured = approval?.onRejectPrompt !== undefined;
  const maxAttemptsReached = onRejectConfigured && currentCount + 1 >= maxAttempts;
  // The on_reject rework is staged (run stays 'paused') only when a prompt is
  // set AND we're under the attempt cap; every other case cancels the run.
  const willStageRework = onRejectConfigured && !maxAttemptsReached;

  // The audit event is identical for all three reject outcomes; the CAS writes it
  // in the SAME transaction as the resolution (#2146).
  const rejectionEvent: workflowDb.GateResolutionEvent = {
    event_type: 'approval_received',
    step_name: approval?.nodeId ?? 'unknown',
    data: { decision: 'rejected', reason: rejectReason },
  };

  // Compare-and-swap resolution guard — a concurrent second reject loses here
  // (resolved=false) and throws BEFORE any events, so the gate events can't
  // duplicate (#2113). Stage-rework stamps the resolution + rework metadata and
  // keeps the run 'paused' (the approval context is rewritten whole so the resumed
  // executor still sees nodeId/onRejectPrompt; `...approval` tolerates a malformed
  // context exactly as the 'unknown' nodeId fallback below). The terminal outcomes
  // flip paused→'cancelled' in a SINGLE atomic UPDATE, so there is never a
  // resolved-but-not-cancelled state that a failed second write could strand
  // (which a reject retry could not self-heal past the guard above). Either way
  // the audit event rides the same transaction, so a failed event write rolls the
  // resolution/cancellation back rather than losing the audit trail (#2146).
  const { resolved: won } = willStageRework
    ? await workflowDb.resolveApprovalGate(
        runId,
        {
          approval: { ...approval, resolved: 'rejected' },
          rejection_reason: rejectReason,
          rejection_count: currentCount + 1,
        },
        [rejectionEvent]
      )
    : await workflowDb.resolveAndCancelApprovalGate(runId, [rejectionEvent]);
  if (!won) {
    throw new Error(`Workflow run ${runId} was already resolved and is awaiting resume.`);
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
    cancelled: !willStageRework,
    maxAttemptsReached,
  };
}

/**
 * Reset persisted per-node provider sessions for a workflow.
 *
 * Filter: workflow_name is required; scope_key narrows to one conversation (or
 * other scope), node_id narrows to one node within that scope. Omitting both
 * scope_key and node_id deletes every row for the workflow across all scopes.
 *
 * Returns the row count deleted.
 */
export async function resetWorkflowNodeSessions(filter: {
  workflow_name: string;
  scope_key?: string;
  node_id?: string;
}): Promise<{ deleted: number }> {
  try {
    return await workflowNodeSessionDb.deleteWorkflowNodeSessions(filter);
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, errorType: err.constructor.name, ...filter },
      'operations.workflow_reset_node_sessions_failed'
    );
    throw new Error(`Failed to reset workflow node sessions: ${err.message}`);
  }
}
