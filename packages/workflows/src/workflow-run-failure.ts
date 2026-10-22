import type { WorkflowRun } from './schemas/workflow-run';
import { isTerminalRunStatus } from './schemas/workflow-run';
import { PAUSE_CAUSE_METADATA_KEY } from './schemas/pause-cause';
import type { RunExitReason, RunStopSignal } from './schemas/run-terminal-reason';
import { DETACHED_LAUNCH_METADATA_KEY, executionClaim } from './store';

export interface WorkflowRunFailureOptions {
  exitReason?: RunExitReason;
  signal?: RunStopSignal;
  /** Restrict failure to the matching detached launch while pending; mismatches do not write. */
  pendingLaunchToken?: string;
  /** Restrict failure to this running claim; null matches the initial execution. Mismatches do not write. */
  expectedExecutionClaim?: string | null;
}

export function prepareWorkflowRunFailure(
  id: string,
  current: WorkflowRun | undefined,
  error: string,
  options?: WorkflowRunFailureOptions
): WorkflowRun | null {
  if (options?.pendingLaunchToken !== undefined) {
    if (
      current?.status !== 'pending' ||
      current.metadata[DETACHED_LAUNCH_METADATA_KEY] !== options.pendingLaunchToken
    )
      return null;
  }
  if (options?.expectedExecutionClaim !== undefined) {
    if (
      current?.status !== 'running' ||
      executionClaim(current.metadata) !== options.expectedExecutionClaim
    )
      return null;
  }
  if (!current) throw new Error(`Run missing: ${id}`);
  const run = structuredClone(current);
  if (isTerminalRunStatus(run.status)) return null;
  if (run.status !== 'running' && run.status !== 'pending')
    throw new Error('Run not in pending/running state');
  run.status = 'failed';
  delete run.metadata.scheduled_resume;
  delete run.metadata.stop_reason;
  delete run.metadata[PAUSE_CAUSE_METADATA_KEY];
  run.metadata.error = error;
  if (options?.exitReason)
    run.metadata.stop_reason = {
      reason: options.exitReason,
      ...(options.signal ? { signal: options.signal } : {}),
    };
  return run;
}
