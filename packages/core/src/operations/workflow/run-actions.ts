import {
  RESUMABLE_WORKFLOW_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
  attentionForm,
  readWorkflowWaitContext,
  pausedAttentionWait,
  readExecutionOwner,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { DashboardWorkflowRun } from '@archon/workflows/schemas/workflow-run-listing';
import type { IWorkflowStore } from '@archon/workflows/store';
import {
  signalWorkflowWaitRequestSchema,
  type SignalWorkflowWaitRequest,
} from '../../schemas/workflow-run';
import type { RunActor } from '../run-authorization';
import { hostname } from 'node:os';
import { getLog, type OperationContext } from './context';
import { rootRunIdOf } from './teardown';
import { removeRunFiles, type RunFilesReport } from '../../services/cleanup/run-files';

export interface WorkflowStatusData {
  runs: DashboardWorkflowRun[];
}

/**
 * Why resume left a run unchanged.
 *
 * `not_resumable`: the run is in a status resume cannot continue, or it failed before it
 *   got a checkout to continue in.
 * `awaiting_answer`: the run is paused at an attention wait that needs an answer.
 * `live_owner`: the run is `running` and its owner, or its root run's owner, answers on
 *   this host. A second executor would run the same work. It resumes once that process
 *   is gone; cancelling it instead ends the run.
 * `owner_unreachable`: the run is `running` and its recorded owner is on another host or
 *   ran as another user, so this process cannot ask whether it is still alive.
 */
export type ResumeRefusal =
  | 'not_resumable'
  | 'awaiting_answer'
  | 'live_owner'
  | 'owner_unreachable';

/**
 * Resume refused; the run is unchanged. The message states why. `restartCommand` is set
 * when the refusal is final for this run and the message ends with the command that
 * starts it again from its record ({@link restartCommandFor}).
 */
export class ResumeRefusedError extends Error {
  constructor(
    readonly reason: ResumeRefusal,
    message: string,
    readonly restartCommand?: string
  ) {
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

/**
 * Delete a terminal run's row, then its files. A file that cannot be removed is logged with
 * its path and returned in the report; the row stays deleted, and
 * `archon workflow cleanup --orphans` removes the file later.
 */
export async function deleteWorkflowRun(
  ctx: OperationContext,
  runId: string,
  actor: RunActor
): Promise<RunFilesReport> {
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_delete_lookup_failed');
  await ctx.assertMayAct(run, actor, 'delete');
  if (!TERMINAL_WORKFLOW_STATUSES.includes(run.status))
    throw new Error(`Cannot delete workflow in '${run.status}' status — cancel it first`);
  await ctx.store.deleteWorkflowRun(runId);
  const report = await removeRunFiles([run], ctx.store);
  if (report.failed.length > 0 || report.unlocated.length > 0)
    getLog().warn(
      { runId, failed: report.failed, unlocated: report.unlocated },
      'operations.workflow_run_files_remove_failed'
    );
  return report;
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
 *
 * A failed or paused run resumes. A `running` run resumes only when no owner answers for
 * it ({@link assertNoLiveOwner}): its process was killed and left it `running`. The store's
 * resume then pins the execution claim read here, so of two resumers only one wins.
 */
export async function resumeWorkflow(
  ctx: OperationContext,
  runId: string,
  actor: RunActor
): Promise<WorkflowRun> {
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_resume_lookup_failed');
  await ctx.assertMayAct(run, actor, 'resume');
  if (run.status === 'running') {
    await assertNoLiveOwner(ctx, run);
    assertHasCheckout(run);
    return run;
  }
  // Abandon removes a run's worktree, so a cancelled run has no checkout left to continue.
  // The text does not say "abandoned": a cancel with a live owner also ends it cancelled.
  const restart = restartCommandFor(run);
  if (run.status === 'cancelled' && restart) {
    throw new ResumeRefusedError(
      'not_resumable',
      `Run ${run.id} was cancelled, so there is nothing to resume. ` +
        `Start it again from its record, without its completed nodes, with: ${restart}`,
      restart
    );
  }
  if (!RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) {
    throw new ResumeRefusedError(
      'not_resumable',
      `Cannot resume run with status '${run.status}'. Only failed, paused, or running runs ` +
        'whose owner is gone can be resumed.'
    );
  }
  // A bare resume continues a message-form wait with empty text, which keeps waits from
  // before answers continuable. Any other form has no answer to continue with.
  const wait = pausedAttentionWait(run);
  if (wait !== undefined && wait.answer === undefined && attentionForm(wait) !== 'message') {
    throw new ResumeRefusedError(
      'awaiting_answer',
      `Run ${run.id} is waiting for an answer to its '${attentionForm(wait)}' attention wait. ` +
        'Answer it with answer instead of resuming it.'
    );
  }
  assertHasCheckout(run);
  return run;
}

/**
 * The command that starts a run again from its record. With no workflow name,
 * `workflow run --supersedes <id>` takes the workflow, message, inputs, definitions source
 * and item from the run's record and starts fresh, without its completed nodes. The line
 * holds only the run id, so it pastes unchanged into any shell.
 *
 * A `workflow:` sub-run gets none: restarting it alone would run the child outside its
 * parent, and the parent is the run to resume or abandon.
 */
export function restartCommandFor(
  run: Pick<WorkflowRun, 'id' | 'parent_run_id'>
): string | undefined {
  return run.parent_run_id ? undefined : `archon workflow run --supersedes ${run.id}`;
}

/**
 * Refuse a run that has no checkout to continue in. A start fails this way when its
 * worktree could not be prepared: the run was recorded first, with no working path, and
 * failed before it got one. Preparing a checkout now would be a new start, so the refusal
 * names the command that makes one.
 */
function assertHasCheckout(run: WorkflowRun): void {
  if (run.working_path) return;
  const restart = restartCommandFor(run);
  throw new ResumeRefusedError(
    'not_resumable',
    `Run ${run.id} failed before its checkout was prepared, so there is nothing to resume.` +
      (restart ? ` Start it again with: ${restart}` : ''),
    restart
  );
}

/**
 * Refuse to resume a `running` run unless this process can tell its owner is gone, the
 * same way cancel tells a live owner from a gone one. A sub-run executes inside its root
 * run's process and publishes no endpoint of its own, so its root's owner is asked too.
 * A recorded owner on another host or user cannot be asked from here, so it is refused
 * rather than assumed dead. A run with no recorded owner (from before owner recording)
 * and nothing answering resumes.
 */
async function assertNoLiveOwner(ctx: OperationContext, run: WorkflowRun): Promise<void> {
  const recorded = readExecutionOwner(run.metadata);
  const ownerName = recorded
    ? `host ${recorded.host}, pid ${String(recorded.pid)}`
    : 'no recorded owner';
  const notChanged = `Resuming it would start a second executor, so run ${run.id} was not changed.`;
  if (ctx.isRunOwnedByThisProcess(run.id) || (await ctx.isRunOwnerAnswering(run.id))) {
    throw new ResumeRefusedError(
      'live_owner',
      `Run ${run.id} is still running: its owner (${ownerName}) answers on this host. ${notChanged}`
    );
  }
  const rootRunId = run.parent_run_id ? await rootRunIdOf(ctx, run.id) : undefined;
  if (rootRunId && (await ctx.isRunOwnerAnswering(rootRunId))) {
    throw new ResumeRefusedError(
      'live_owner',
      `Run ${run.id} is a sub-run of ${rootRunId}, whose owner still answers on this host. ${notChanged}`
    );
  }
  const where = unreachableOwner(recorded);
  if (where !== undefined) {
    throw new ResumeRefusedError(
      'owner_unreachable',
      `Run ${run.id} is marked running and its recorded owner ran ${where}. ` +
        `Its owner cannot be asked from here, so run ${run.id} was not changed. ` +
        'Resume it from that host and user, or abandon it if its process is gone.'
    );
  }
}

/**
 * Where a recorded owner runs when this process cannot ask it: on another host or as
 * another user. Undefined when it is local or none is recorded.
 */
export function unreachableOwner(
  recorded: ReturnType<typeof readExecutionOwner>
): string | undefined {
  if (!recorded) return undefined;
  const thisHost = hostname();
  const thisUid = process.getuid?.();
  if (recorded.host !== thisHost)
    return `on another host (${recorded.host}, pid ${String(recorded.pid)}); this is ${thisHost}`;
  if (recorded.uid !== undefined && thisUid !== undefined && recorded.uid !== thisUid)
    return `as another user (uid ${String(recorded.uid)}, pid ${String(recorded.pid)}); this is uid ${String(thisUid)}`;
  return undefined;
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
