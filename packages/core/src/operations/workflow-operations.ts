/**
 * Shared workflow business logic — approve, reject, status, resume, abandon.
 *
 * Both CLI and command-handler are thin formatting adapters over these functions.
 * Operations throw on errors; callers catch and format for their platform.
 */
import { createLogger } from '@archon/paths';
import {
  RESUMABLE_WORKFLOW_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
  isApprovalContext,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun, ApprovalContext } from '@archon/workflows/schemas/workflow-run';
import * as workflowDb from '../db/workflows';
import * as workflowEventDb from '../db/workflow-events';

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
 * Abandon a non-terminal workflow run (marks it as cancelled).
 */
export async function abandonWorkflow(runId: string): Promise<WorkflowRun> {
  const run = await getRunOrThrow(runId, 'operations.workflow_abandon_lookup_failed');
  if (TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
    throw new Error(`Cannot abandon run with status '${run.status}'. Run is already terminal.`);
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
 * Transitions run to 'failed' so findResumableRun picks it up on next invocation.
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

  const approvalComment = comment ?? 'Approved';

  try {
    // Interactive loop gate — store user input in metadata for the next iteration.
    // Note: node_completed is NOT written here. The executor writes it when the AI
    // emits the completion signal (meaning the user actually approved). Writing it
    // here would cause the resume to skip the loop node entirely.
    if (approval.type === 'interactive_loop') {
      await workflowEventDb.createWorkflowEvent({
        workflow_run_id: runId,
        event_type: 'approval_received',
        step_name: approval.nodeId,
        data: { decision: 'approved', comment: approvalComment, iteration: approval.iteration },
      });
      // Transition to 'failed' so findResumableRun picks it up.
      // IMPORTANT: metadata is MERGED (not replaced) — the approval context must survive
      // intact so the resumed executor can detect the correct startIteration.
      await workflowDb.updateWorkflowRun(runId, {
        status: 'failed',
        metadata: { loop_user_input: approvalComment },
      });
      return {
        workflowName: run.workflow_name,
        workingPath: run.working_path,
        userMessage: run.user_message,
        codebaseId: run.codebase_id,
        conversationId: run.conversation_id,
        type: 'interactive_loop',
      };
    }

    // Standard approval node path
    const nodeOutput = approval.captureResponse === true ? approvalComment : '';
    await workflowEventDb.createWorkflowEvent({
      workflow_run_id: runId,
      event_type: 'node_completed',
      step_name: approval.nodeId,
      data: { node_output: nodeOutput, approval_decision: 'approved' },
    });
    await workflowEventDb.createWorkflowEvent({
      workflow_run_id: runId,
      event_type: 'approval_received',
      step_name: approval.nodeId,
      data: { decision: 'approved', comment: approvalComment },
    });
    // Transition to 'failed' so findResumableRun picks it up. Clear any rejection state.
    await workflowDb.updateWorkflowRun(runId, {
      status: 'failed',
      metadata: { approval_response: 'approved', rejection_reason: '', rejection_count: 0 },
    });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, errorType: err.constructor.name, runId },
      'operations.workflow_approve_failed'
    );
    throw new Error(`Failed to approve workflow run ${runId}: ${err.message}`);
  }
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
 * Reject a paused workflow run.
 *
 * If `onRejectPrompt` is set and under max attempts, transitions to 'failed' for retry.
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
  const rejectReason = reason ?? 'Rejected';
  const currentCount = (run.metadata.rejection_count as number | undefined) ?? 0;
  const maxAttempts = approval?.onRejectMaxAttempts ?? 3;

  try {
    await workflowEventDb.createWorkflowEvent({
      workflow_run_id: runId,
      event_type: 'approval_received',
      step_name: approval?.nodeId ?? 'unknown',
      data: { decision: 'rejected', reason: rejectReason },
    });

    if (approval?.onRejectPrompt !== undefined) {
      if (currentCount + 1 >= maxAttempts) {
        await workflowDb.cancelWorkflowRun(runId);
        return {
          workflowName: run.workflow_name,
          workingPath: run.working_path,
          userMessage: run.user_message,
          codebaseId: run.codebase_id,
          conversationId: run.conversation_id,
          cancelled: true,
          maxAttemptsReached: true,
        };
      }
      await workflowDb.updateWorkflowRun(runId, {
        status: 'failed',
        metadata: { rejection_reason: rejectReason, rejection_count: currentCount + 1 },
      });
      return {
        workflowName: run.workflow_name,
        workingPath: run.working_path,
        userMessage: run.user_message,
        codebaseId: run.codebase_id,
        conversationId: run.conversation_id,
        cancelled: false,
        maxAttemptsReached: false,
      };
    }

    await workflowDb.cancelWorkflowRun(runId);
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, errorType: err.constructor.name, runId },
      'operations.workflow_reject_failed'
    );
    throw new Error(`Failed to reject workflow run ${runId}: ${err.message}`);
  }
  return {
    workflowName: run.workflow_name,
    workingPath: run.working_path,
    userMessage: run.user_message,
    codebaseId: run.codebase_id,
    conversationId: run.conversation_id,
    cancelled: true,
    maxAttemptsReached: false,
  };
}
