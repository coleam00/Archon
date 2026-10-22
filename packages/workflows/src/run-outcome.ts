import { isWorkflowExecutionInterruption } from './execution-interruption';
import { ParentStatusReadError } from './parent-status-read';
import { createLogger } from '@archon/paths';
import type { ChildIsolationResolver } from './child-isolation';
import type { executeDagWorkflow } from './dag-executor';
import { containerPauseHandoff, readPublishedContainerPause } from './dag/pause';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import { spellWorkflowCommand } from './deps';
import { getWorkflowEventEmitter } from './event-emitter';
import { logWorkflowError } from './logger';
import {
  continueBlockedRun,
  isFanOutParentReleased,
  maybeResumeParentRun,
  releaseContinuablePauseSlot,
} from './parent-resume';
import { safeSendMessage, sendCriticalMessage } from './platform-messages';
import type { ExecuteWorkflowOptions } from './executor';
import type { ResolvedWorkflow, WorkflowExecutionResult, WorkflowRun } from './schemas';
import { isApprovalContext, isTerminalRunStatus, pendingWorkflowWaitDeadline } from './schemas';
import { deadlineWaitCursor } from './store';
import { TerminalStatusWriteError, requireTerminalStatusWrite } from './terminal-status-write';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor');
  return cachedLog;
}

/**
 * How an execution left its run, read by `executeWorkflow`'s finally-block backstop.
 * `executionStopped`: ownership passed to a successor (a source release, a published
 * container pause, a continued fan-out parent or a handoff error), or lifecycle
 * observation was interrupted. The backstop has no authority over that row.
 * `terminalStatusWriteFailed`: a terminal status write was rejected, and a second
 * write over that channel would either fail again or mask the real error.
 */
export interface RunExitState {
  executionStopped: boolean;
  terminalStatusWriteFailed: boolean;
}

type DagResult = Awaited<ReturnType<typeof executeDagWorkflow>>;

/**
 * Read the run's status after the DAG returned and turn it into the execution result:
 * hand off a run another owner took over, re-enter a paused parent when this child
 * ended, continue a fan-out parent its children released, then report completed, paused
 * or failed.
 */
export async function settleRunOutcome(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  dagResult: DagResult,
  opts: Pick<ExecuteWorkflowOptions, 'resolveChildIsolation' | 'onExecutionClaimed'>,
  exit: RunExitState
): Promise<WorkflowExecutionResult> {
  const settled = await readSettledRun(deps, workflowRun, dagResult, exit);
  if (settled.handedOff) return settled.result;
  const finalStatus = settled.run;
  if (!finalStatus) return didNotComplete(workflowRun.id);
  const { resolveChildIsolation } = opts;
  await resumeParentOfEndedChild(
    deps,
    platform,
    conversationId,
    finalStatus,
    resolveChildIsolation
  );
  if (finalStatus.status === 'paused') {
    const continued = await continueReleasedFanOutParent(
      deps,
      platform,
      conversationId,
      finalStatus,
      resolveChildIsolation,
      opts.onExecutionClaimed
    );
    if (continued !== undefined) {
      exit.executionStopped = true;
      return continued;
    }
  }
  if (finalStatus.status === 'completed') {
    const summary = typeof dagResult === 'string' ? dagResult : undefined;
    return { success: true, workflowRunId: workflowRun.id, summary };
  }
  if (finalStatus.status === 'paused') return pausedResult(deps, finalStatus);
  return didNotComplete(workflowRun.id);
}

/**
 * Read the run the DAG left. A DAG that released its source or published a container
 * pause handed ownership to a successor. A released source, or a published pause another
 * owner already moved past, ends this execution with a handoff result.
 */
async function readSettledRun(
  deps: WorkflowDeps,
  workflowRun: WorkflowRun,
  dagResult: DagResult,
  exit: RunExitState
): Promise<
  | { handedOff: true; result: WorkflowExecutionResult }
  | { handedOff: false; run: WorkflowRun | null }
> {
  if (typeof dagResult !== 'object') {
    // executeDagWorkflow throws on fatal errors; check DB status for result
    return { handedOff: false, run: await deps.store.getWorkflowRun(workflowRun.id) };
  }
  exit.executionStopped = true;
  if (dagResult.kind === 'source_release') {
    if (dagResult.released) {
      return {
        handedOff: true,
        result: { success: true, paused: true, workflowRunId: workflowRun.id },
      };
    }
    return { handedOff: false, run: await deps.store.getWorkflowRun(workflowRun.id) };
  }
  const run = await readPublishedContainerPause(deps.store, workflowRun.id);
  const handoff = containerPauseHandoff(run, workflowRun, dagResult);
  return handoff ? { handedOff: true, result: handoff } : { handedOff: false, run };
}

/**
 * Sub-run re-entry (#2121 Phase 2): if this run is a `workflow:` child that just reached a
 * terminal state, re-enter its paused parent in-process. A no-op on the synchronous
 * first-run path (parent still 'running').
 */
async function resumeParentOfEndedChild(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  finalStatus: WorkflowRun,
  resolveChildIsolation: ChildIsolationResolver | undefined
): Promise<void> {
  if (!finalStatus.parent_run_id || !isTerminalRunStatus(finalStatus.status)) return;
  await maybeResumeParentRun(
    deps,
    platform,
    conversationId,
    finalStatus,
    // The parent resumes mid-DAG and may still have isolated sub-run nodes ahead
    // of it; without this it would fail them for a missing resolver the surface
    // did inject. Same resolver the child ran with — it is codebase-bound and the
    // child shares the parent's codebase.
    resolveChildIsolation
  );
}

/**
 * A fan-out parent builds its gate from a fresh read of its children, then commits its
 * pause. A child that finished in between saw this run still `running`, so its hook stood
 * down; check again now that the pause is committed. Whichever side reads second sees the
 * other, and the resume claim lets only one of them continue.
 */
async function continueReleasedFanOutParent(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  paused: WorkflowRun,
  resolveChildIsolation: ChildIsolationResolver | undefined,
  onExecutionClaimed: ExecuteWorkflowOptions['onExecutionClaimed']
): Promise<WorkflowExecutionResult | undefined> {
  const notifyStuck = async (reason: string): Promise<void> => {
    await safeSendMessage(
      platform,
      conversationId,
      `⚠️ Run \`${paused.id.slice(0, 8)}\`'s sub-runs finished, but it couldn't ` +
        `continue (${reason}). Resume it manually: ` +
        `\`${spellWorkflowCommand(platform, `resume ${paused.id}`)}\``
    );
  };
  let released = false;
  try {
    released =
      isApprovalContext(paused.metadata.approval) &&
      paused.metadata.approval.type === 'fan_out' &&
      (await isFanOutParentReleased(deps, paused));
  } catch (err) {
    getLog().error(
      { err: err as Error, workflowRunId: paused.id },
      'workflow.parent_resume_children_lookup_failed'
    );
    await notifyStuck('its sub-runs could not be looked up');
  }
  if (!released) return undefined;
  return continueBlockedRun(
    deps,
    platform,
    conversationId,
    paused,
    notifyStuck,
    {},
    resolveChildIsolation,
    onExecutionClaimed
  );
}

async function pausedResult(
  deps: WorkflowDeps,
  paused: WorkflowRun
): Promise<WorkflowExecutionResult> {
  const wait = pendingWorkflowWaitDeadline(paused);
  const waitCursor = wait ? deadlineWaitCursor(wait) : undefined;
  await releaseContinuablePauseSlot(deps, paused);
  return {
    success: true,
    paused: true,
    workflowRunId: paused.id,
    ...(waitCursor ? { waitCursor } : {}),
  };
}

function didNotComplete(workflowRunId: string): WorkflowExecutionResult {
  return { success: false, workflowRunId, error: 'Workflow did not complete successfully' };
}

/**
 * Top-level error handler: mark the run failed and return the failure as the result.
 * Execution interruptions leave lifecycle ownership unresolved and are rethrown.
 * Rejected terminal writes also prevent a second write through the backstop.
 */
export async function recordUnhandledRunFailure(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  logDir: string,
  error: unknown,
  exit: RunExitState
): Promise<WorkflowExecutionResult> {
  if (isWorkflowExecutionInterruption(error)) {
    exit.executionStopped = true;
    if (error instanceof TerminalStatusWriteError) exit.terminalStatusWriteFailed = true;
    if (error instanceof ParentStatusReadError) {
      getLog().error(
        { err: error.cause, workflowRunId: workflowRun.id, nodeId: error.nodeId },
        'workflow.parent_status_read_failed'
      );
      getWorkflowEventEmitter().unregisterRun(workflowRun.id);
    }
    throw error;
  }
  const err = error as Error;
  getLog().error(
    { err, workflowName: workflow.name, workflowId: workflowRun.id },
    'workflow_execution_unhandled_error'
  );

  // The log file and the user's notification are independent of the terminal write and
  // precede it, so a rejection cannot silence them. The live event follows the write:
  // it announces only a failure this call committed. Terminal telemetry is reported by
  // the run store after the write commits.
  await reportRunFailure(platform, conversationId, workflowRun.id, logDir, err);
  try {
    await recordFailedStatus(deps, workflow, workflowRun.id, err);
  } catch (writeError) {
    // A terminal status write is part of the result: if it fails, reject instead of
    // reporting a completed process for a row that still says running.
    exit.terminalStatusWriteFailed = true;
    throw writeError;
  }
  return { success: false, workflowRunId: workflowRun.id, error: err.message };
}

/** Log the failure to the run's log file and notify the user; neither failure is fatal. */
async function reportRunFailure(
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRunId: string,
  logDir: string,
  err: Error
): Promise<void> {
  try {
    await logWorkflowError(logDir, workflowRunId, err.message);
  } catch (logError) {
    getLog().error(
      { err: logError as Error, workflowId: workflowRunId },
      'workflow_error_log_write_failed'
    );
  }

  const delivered = await sendCriticalMessage(
    platform,
    conversationId,
    `❌ **Workflow failed**: ${err.message}`
  );
  if (!delivered) {
    getLog().error(
      { workflowId: workflowRunId, originalError: err.message },
      'user_failure_notification_failed'
    );
  }
}

async function recordFailedStatus(
  deps: WorkflowDeps,
  workflow: ResolvedWorkflow,
  workflowRunId: string,
  err: Error
): Promise<void> {
  const emitter = getWorkflowEventEmitter();
  try {
    const { failed } = await requireTerminalStatusWrite(
      deps.store.failWorkflowRun(workflowRunId, err.message, { exitReason: 'unhandled_error' }),
      {
        workflowRunId,
        site: 'db_record_failure_failed',
      }
    );
    // A run another writer already finished keeps that writer's outcome and announcement.
    if (failed) {
      emitter.emit({
        type: 'workflow_failed',
        runId: workflowRunId,
        workflowName: workflow.name,
        error: err.message,
      });
    }
  } catch (writeError) {
    if (writeError instanceof TerminalStatusWriteError) {
      writeError.message += ` (while recording workflow failure: ${err.message})`;
    }
    throw writeError;
  } finally {
    emitter.unregisterRun(workflowRunId);
  }
}
