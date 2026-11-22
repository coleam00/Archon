import type { ResourceBlocker } from '../resource-start-store';
import { describeInstallHold, type InstallHold } from '../schemas/resource-start';
import { describeRunLimit, type RunLimit } from '../schemas/run-limit';

/** Only a zero-row pause CAS produces this error; storage failures must propagate. */
export class WorkflowRunPauseConflictError extends Error {
  constructor(runId: string) {
    super(`Workflow run not found or not in running state (id: ${runId})`);
    this.name = 'WorkflowRunPauseConflictError';
  }
}

/**
 * Thrown by resumeWorkflowRun when the target run is no longer in a resumable
 * state (already running/terminal, or concurrently resumed). Callers translate
 * this into a user-facing "already being resumed" message instead of leaking
 * the raw internal error string.
 */
export class WorkflowNotResumableError extends Error {
  constructor(
    public readonly runId: string,
    public readonly currentStatus: string
  ) {
    super(
      `Workflow run is not resumable (id: ${runId}, status: ${currentStatus}). ` +
        'It may have already been resumed, completed, or cancelled.'
    );
    this.name = 'WorkflowNotResumableError';
  }
}

/**
 * What a refused resume leaves behind: a failed run stays failed; a paused run stays
 * paused, and `waiting` means it also keeps its place as a capacity waiter.
 */
export type ResumeRefusal = 'failed' | 'paused' | 'waiting';

export class WorkflowResourceBusyError extends Error {
  constructor(
    public readonly runId: string,
    public readonly blocker: ResourceBlocker,
    public readonly refusal: ResumeRefusal = 'failed'
  ) {
    const reason = `Workflow run '${runId}' cannot resume while ${blocker.kind === 'run' ? 'resource owner' : 'queued request'} '${blocker.id}' has priority.`;
    super(
      refusal === 'waiting'
        ? `${reason} It stays paused and keeps its place; a continuation host continues it once capacity frees.`
        : refusal === 'paused'
          ? `${reason} It stays paused; a continuation host continues it once its wait ends and capacity frees.`
          : reason
    );
    this.name = 'WorkflowResourceBusyError';
  }
}

/**
 * Another run of the same workflow holds the item this run is on (`holdsItem`), so this run
 * cannot be claimed or resumed now. Thrown by `claimPendingWorkflowRun` and
 * `resumeWorkflowRun`; nothing was written. A pending run that gets it waits and asks again,
 * or is refused under `--no-wait`.
 */
export class WorkflowItemHeldError extends Error {
  constructor(
    public readonly runId: string,
    public readonly holderRunId: string,
    public readonly workflow: string,
    public readonly itemKey: string
  ) {
    super(`Item '${itemKey}' is held by run ${holderRunId} of workflow '${workflow}'.`);
    this.name = 'WorkflowItemHeldError';
  }
}

/**
 * The install hold is set, so admission admits no new run. Thrown by `admitPendingRun` and
 * by `claimPendingWorkflowRun` for a top-level run nothing admitted; nothing was written.
 * A hand start that gets it waits and asks again, or is refused under `--no-wait`.
 */
export class InstallHeldError extends Error {
  constructor(public readonly hold: InstallHold) {
    super(`New runs are held on this install (${describeInstallHold(hold)}).`);
    this.name = 'InstallHeldError';
  }
}

/**
 * The install's run limit (`concurrency.runs`) is full and the run is not inside a tree that
 * already counts, so it is not admitted now. Thrown by `admitPendingRun`,
 * `claimPendingWorkflowRun` and `resumeWorkflowRun` (a hand start, or a failed tree's resume);
 * nothing was written. A hand start that gets it waits and asks again, or is refused under
 * `--no-wait`.
 */
export class RunLimitError extends Error {
  constructor(public readonly runLimit: RunLimit) {
    super(`The run limit is full (${describeRunLimit(runLimit)}).`);
    this.name = 'RunLimitError';
  }
}

/**
 * A concurrency number in the install config (`concurrency.*`) is invalid, so what it
 * governs is refused, never run without the limit. Thrown before anything is written; the
 * message names the file, the key and the problem.
 */
export class ConcurrencyConfigError extends Error {
  constructor(configPath: string, detail: string, refused: string) {
    super(
      `Invalid concurrency config in '${configPath}': ${detail}. ` +
        `${refused} are refused until the config is fixed.`
    );
    this.name = 'ConcurrencyConfigError';
  }
}
