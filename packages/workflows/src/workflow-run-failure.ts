import type { WorkflowRun } from './schemas/workflow-run';
import { isTerminalRunStatus } from './schemas/workflow-run';
import { PAUSE_CAUSE_METADATA_KEY } from './schemas/pause-cause';
import { CHANGE_SIZE_METADATA_KEY, type ChangeSize } from './schemas/change-size';
import type { RunExitReason, RunStopSignal } from './schemas/run-terminal-reason';
import { DETACHED_LAUNCH_METADATA_KEY, claimedFailureStatuses, executionClaim } from './store';

export interface WorkflowRunFailureOptions {
  /** Restrict failure to a pending run; mismatches do not write. */
  pendingOnly?: true;
  exitReason?: RunExitReason;
  signal?: RunStopSignal;
  /** Restrict failure to the matching detached launch while pending; mismatches do not write. */
  pendingLaunchToken?: string;
  /** Restrict failure to this running claim; null matches the initial execution. Mismatches do not write. */
  expectedExecutionClaim?: string | null;
  /**
   * With `expectedExecutionClaim`, also fail a `paused` row that still carries that claim.
   * Every claim mints a new one and no pause changes it, so such a row was paused by the
   * same pass and nobody has claimed it since.
   */
  pausedUnderClaim?: true;
  /** The item run's change size at the clean commit its checkout ended on (#6261). */
  changeSize?: ChangeSize | null;
}

export function prepareWorkflowRunFailure(
  id: string,
  current: WorkflowRun | undefined,
  error: string,
  options?: WorkflowRunFailureOptions
): WorkflowRun | null {
  if (options?.pendingOnly && current?.status !== 'pending') return null;
  if (
    options?.pendingLaunchToken !== undefined &&
    (current?.status !== 'pending' ||
      current.metadata[DETACHED_LAUNCH_METADATA_KEY] !== options.pendingLaunchToken)
  )
    return null;
  const claimed = claimedFailureStatuses(options);
  if (
    options?.expectedExecutionClaim !== undefined &&
    (current === undefined ||
      !claimed.includes(current.status) ||
      executionClaim(current.metadata) !== options.expectedExecutionClaim)
  )
    return null;
  if (!current) throw new Error(`Run missing: ${id}`);
  const run = structuredClone(current);
  if (isTerminalRunStatus(run.status)) return null;
  if (run.status !== 'pending' && !claimed.includes(run.status))
    throw new Error('Run not in pending/running state');
  run.status = 'failed';
  delete run.metadata.scheduled_resume;
  delete run.metadata.stop_reason;
  delete run.metadata[PAUSE_CAUSE_METADATA_KEY];
  // Replaces any size an earlier pass left; undefined drops the key when the run is written.
  run.metadata[CHANGE_SIZE_METADATA_KEY] = options?.changeSize;
  run.metadata.error = error;
  if (options?.exitReason)
    run.metadata.stop_reason = {
      reason: options.exitReason,
      ...(options.signal ? { signal: options.signal } : {}),
    };
  return run;
}
