import {
  RESUMABLE_WORKFLOW_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
  attentionForm,
  readWorkflowWaitContext,
  pausedAttentionWait,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { DashboardWorkflowRun } from '@archon/workflows/schemas/workflow-run-listing';
import type { IWorkflowStore } from '@archon/workflows/store';
import {
  signalWorkflowWaitRequestSchema,
  type SignalWorkflowWaitRequest,
} from '../../schemas/workflow-run';
import type { RunActor } from '../run-authorization';
import { getLog, type OperationContext } from './context';

export interface WorkflowStatusData {
  runs: DashboardWorkflowRun[];
}

/** Resume refused; the run is unchanged. The message states why. */
export class ResumeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeRefusedError';
  }
}

export async function signalWorkflowWait(
  ctx: OperationContext,
  runId: string,
  request: SignalWorkflowWaitRequest,
  actor: RunActor
): Promise<{ signaled: boolean }> {
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_signal_lookup_failed');
  await ctx.assertMayAct(run, actor, 'signal');
  const wait = readWorkflowWaitContext(run.metadata?.wait);
  const { event, occurrence, resumeAt, payload } = signalWorkflowWaitRequestSchema.parse(request);
  if (
    wait?.kind !== 'event' ||
    wait.event !== event ||
    (occurrence !== undefined && wait.pauseId !== occurrence) ||
    (resumeAt !== undefined && wait.resumeAt !== resumeAt)
  )
    return { signaled: false };
  return ctx.store.signalWorkflowWait(runId, wait, payload);
}

export async function deleteWorkflowRun(
  ctx: OperationContext,
  runId: string,
  actor: RunActor
): Promise<void> {
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_delete_lookup_failed');
  await ctx.assertMayAct(run, actor, 'delete');
  if (!TERMINAL_WORKFLOW_STATUSES.includes(run.status))
    throw new Error(`Cannot delete workflow in '${run.status}' status — cancel it first`);
  await ctx.store.deleteWorkflowRun(runId);
}

/** List running and paused workflow runs, optionally scoped to one codebase. */
export async function getWorkflowStatus(
  ctx: OperationContext,
  options?: { codebaseId?: string }
): Promise<WorkflowStatusData> {
  const { runs } = await ctx.store.listWorkflowRuns({
    status: ['running', 'paused'],
    limit: 50,
    ...(options?.codebaseId ? { codebaseId: options.codebaseId } : {}),
  });
  return { runs };
}

/**
 * Validate that a run can be resumed and return it.
 * Does NOT execute the workflow — callers decide whether to run.
 */
export async function resumeWorkflow(
  ctx: OperationContext,
  runId: string,
  actor: RunActor
): Promise<WorkflowRun> {
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_resume_lookup_failed');
  await ctx.assertMayAct(run, actor, 'resume');
  if (!RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) {
    throw new ResumeRefusedError(
      `Cannot resume run with status '${run.status}'. Only failed or paused runs can be resumed.`
    );
  }
  // A bare resume continues a message-form wait with empty text, which keeps waits from
  // before answers continuable. Any other form has no answer to continue with.
  const wait = pausedAttentionWait(run);
  if (wait !== undefined && wait.answer === undefined && attentionForm(wait) !== 'message') {
    throw new ResumeRefusedError(
      `Run ${run.id} is waiting for an answer to its '${attentionForm(wait)}' attention wait. ` +
        'Answer it with answer instead of resuming it.'
    );
  }
  return run;
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
export async function resetWorkflowNodeSessions(
  ctx: OperationContext,
  filter: Parameters<IWorkflowStore['deleteWorkflowNodeSessions']>[0]
): Promise<{ deleted: number }> {
  try {
    return await ctx.store.deleteWorkflowNodeSessions(filter);
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, errorType: err.constructor.name, ...filter },
      'operations.workflow_reset_node_sessions_failed'
    );
    throw new Error(`Failed to reset workflow node sessions: ${err.message}`);
  }
}
